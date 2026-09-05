import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { UPGRADE_CANCELLED, combineAbortSignals, errorMessage, withTimeout } from '@tmex/shared';
import { getInstallInfo } from './install-info';
import { downloadVerifiedRelease, resolveReleaseCacheDir } from './release-download';
import { resolveUpgradeInstallDir } from './upgrade';
import type { AuthorizedUpgradeForward } from './upgrade-service';

const FAILED_TTL_MS = 10 * 60 * 1000;

export const REMOTE_UPGRADE_TIMEOUTS = {
  downloadMs: 10 * 60 * 1000,
  pushMs: 15 * 60 * 1000,
  startMs: 60 * 1000,
};

/** 推包重试的退避梯度（毫秒），封顶 15 s。 */
export const PUSH_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000] as const;
/** 目标支持续传时最多推 8 次；每次只补发缺的那一段。 */
export const PUSH_MAX_ATTEMPTS = 8;
/** 目标不支持续传：重传只能从头来，最多 3 次，且只在链路断了才重试。 */
export const LEGACY_PUSH_MAX_ATTEMPTS = 3;
/** 问一次已收偏移的超时；问不到就当 0 从头推，不值得为它挂住整个阶段。 */
const OFFSET_QUERY_TIMEOUT_MS = 30 * 1000;

export type RemoteUpgradePhase = 'download' | 'push' | 'start';

export type RemoteUpgradeJobSnapshot = {
  state: RemoteUpgradeJobState;
  targetVersion: string;
  error: string | null;
  startedAt: string;
  phase: RemoteUpgradePhase;
  /** 目标已确认收到的字节数 */
  pushedBytes: number;
  /** 升级包总字节数；下载完成前为 0 */
  totalBytes: number;
  /** 当前是第几次推送尝试，从 1 起 */
  attempt: number;
};

export type RemoteUpgradeJobState = 'running' | 'failed' | 'handed-off' | 'cancelled';

export type RemoteUpgradeStartResult =
  | { ok: true; snapshot: RemoteUpgradeJobSnapshot }
  | { ok: false; code: 'UPGRADE_IN_PROGRESS' };

type DownloadedRelease = { path: string; sha256: string; bytes: number };

type Job = {
  nodeId: string;
  version: string;
  startedAt: string;
  failedAt: string | null;
  state: RemoteUpgradeJobState;
  error: string | null;
  finished: Promise<RemoteUpgradeJobSnapshot>;
  abort: AbortController;
  phase: RemoteUpgradePhase;
  pushed: boolean;
  pushedBytes: number;
  totalBytes: number;
  attempt: number;
  fileStream: ReadableStream<Uint8Array> | null;
  pushPromise: Promise<Response> | null;
  startPromise: Promise<Response> | null;
  upgradeCapabilities: string[];
};

type RemoteUpgradeTimeouts = {
  downloadMs: number;
  pushMs: number;
  startMs: number;
};

type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

const jobs = new Map<string, Job>();

export function resetRemoteUpgradeJobsForTests(): void {
  for (const job of jobs.values()) {
    job.abort.abort();
  }
  jobs.clear();
}

export function getRemoteUpgradeJob(
  nodeId: string,
  now = Date.now()
): RemoteUpgradeJobSnapshot | null {
  const job = jobs.get(nodeId);
  if (!job) return null;
  if (job.state === 'failed' || job.state === 'cancelled') {
    const failed = Date.parse(job.failedAt ?? job.startedAt);
    if (!Number.isFinite(failed) || now - failed > FAILED_TTL_MS) {
      jobs.delete(nodeId);
      return null;
    }
  }
  return snapshotOf(job);
}

export function consumeHandedOffJob(nodeId: string): boolean {
  const job = jobs.get(nodeId);
  if (!job || job.state !== 'handed-off') return false;
  jobs.delete(nodeId);
  return true;
}

export function waitForRemoteUpgradeJob(nodeId: string): Promise<RemoteUpgradeJobSnapshot> {
  const job = jobs.get(nodeId);
  if (!job) return Promise.reject(new Error(`no remote upgrade job for ${nodeId}`));
  return job.finished;
}

export function hasRunningRemoteUpgradeJob(nodeId: string): boolean {
  return jobs.get(nodeId)?.state === 'running';
}

export function startRemoteUpgradeJob(opts: {
  nodeId: string;
  version: string;
  req: Request;
  forward: AuthorizedUpgradeForward;
  download?: (version: string, signal?: AbortSignal) => Promise<DownloadedRelease>;
  now?: () => number;
  timeouts?: Partial<RemoteUpgradeTimeouts>;
  upgradeCapabilities?: readonly string[];
  /** 单测注入：跳过退避真实等待。 */
  sleep?: SleepFn;
}): RemoteUpgradeStartResult {
  const existing = jobs.get(opts.nodeId);
  if (existing?.state === 'running') return { ok: false, code: 'UPGRADE_IN_PROGRESS' };

  const nowFn = opts.now ?? Date.now;
  const startedAt = new Date(nowFn()).toISOString();
  const detached = detachRequest(opts.req);
  let resolveFinished!: (snapshot: RemoteUpgradeJobSnapshot) => void;
  const finished = new Promise<RemoteUpgradeJobSnapshot>((resolve) => {
    resolveFinished = resolve;
  });
  const job: Job = {
    nodeId: opts.nodeId,
    version: opts.version,
    startedAt,
    failedAt: null,
    state: 'running',
    error: null,
    finished,
    abort: new AbortController(),
    phase: 'download',
    pushed: false,
    pushedBytes: 0,
    totalBytes: 0,
    attempt: 0,
    fileStream: null,
    pushPromise: null,
    startPromise: null,
    upgradeCapabilities: [...(opts.upgradeCapabilities ?? ['staged-package', 'upgrade-cancel'])],
  };
  jobs.set(opts.nodeId, job);

  const download = opts.download ?? defaultDownload;
  const timeouts: RemoteUpgradeTimeouts = {
    ...REMOTE_UPGRADE_TIMEOUTS,
    ...opts.timeouts,
  };
  void runJob(job, {
    req: detached,
    forward: opts.forward,
    download,
    timeouts,
    nowFn,
    sleep: opts.sleep ?? defaultSleep,
  }).then((snapshot) => resolveFinished(snapshot));
  return { ok: true, snapshot: snapshotOf(job) };
}

export type RemoteUpgradeCancelResult =
  | { handled: true; snapshot: RemoteUpgradeJobSnapshot }
  | { handled: false }
  | { handled: 'unsupported' };

export async function cancelRemoteUpgradeJob(opts: {
  nodeId: string;
  req: Request;
  forward: AuthorizedUpgradeForward;
}): Promise<RemoteUpgradeCancelResult> {
  const job = jobs.get(opts.nodeId);
  if (!job) return { handled: false };
  if (job.state === 'handed-off' || job.state === 'failed') return { handled: false };
  if (job.state === 'cancelled') return { handled: true, snapshot: snapshotOf(job) };
  if (job.state !== 'running') return { handled: false };

  const canCancelTarget = supportsUpgradeCancel(job);

  if (job.startPromise) {
    if (!canCancelTarget) return { handled: 'unsupported' };
    return finishStartCancel(job, opts.req, opts.forward);
  }

  if (job.pushed || job.phase === 'start') {
    if (!canCancelTarget) return { handled: 'unsupported' };
    job.abort.abort();
    await job.fileStream?.cancel().catch(() => {});
    job.fileStream = null;
    await job.pushPromise?.then(
      (res) => res.body?.cancel().catch(() => {}),
      () => {}
    );
    await deleteStagedBestEffort(job, opts.req, opts.forward);
    return { handled: true, snapshot: markCancelled(job) };
  }

  job.abort.abort();
  await job.fileStream?.cancel().catch(() => {});
  job.fileStream = null;

  if (job.pushPromise) {
    const pushed = await job.pushPromise.then(
      (res) => res,
      () => null
    );
    if (job.startPromise) {
      if (!canCancelTarget) return { handled: 'unsupported' };
      return finishStartCancel(job, opts.req, opts.forward);
    }
    const landed = pushed != null && pushed.status >= 200 && pushed.status < 300;
    if (landed) job.pushed = true;
    if (landed && !canCancelTarget) return { handled: 'unsupported' };
    await deleteStagedBestEffort(job, opts.req, opts.forward);
    return { handled: true, snapshot: markCancelled(job) };
  }

  return { handled: true, snapshot: markCancelled(job) };
}

async function finishStartCancel(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward
): Promise<RemoteUpgradeCancelResult> {
  const started = await job.startPromise?.then(
    (res) => res,
    () => null
  );
  if (job.state === 'handed-off') return { handled: false };
  if (job.state === 'cancelled') return { handled: true, snapshot: snapshotOf(job) };
  const accepted = started != null && started.status >= 200 && started.status < 300;
  if (accepted) {
    job.state = 'handed-off';
    job.error = null;
    return { handled: false };
  }
  await deleteStagedBestEffort(job, req, forward);
  return { handled: true, snapshot: markCancelled(job) };
}

function supportsUpgradeCancel(job: Job): boolean {
  return job.upgradeCapabilities.includes('upgrade-cancel');
}

function isCancelled(job: Job): boolean {
  return job.state === 'cancelled';
}

type PhaseEnd = { done: true; snapshot: RemoteUpgradeJobSnapshot };
type PhaseContinue<T> = { done: false; value: T };

type JobDeps = {
  req: Request;
  forward: AuthorizedUpgradeForward;
  download: (version: string, signal?: AbortSignal) => Promise<DownloadedRelease>;
  timeouts: RemoteUpgradeTimeouts;
  nowFn: () => number;
  sleep: SleepFn;
};

async function runJob(job: Job, deps: JobDeps): Promise<RemoteUpgradeJobSnapshot> {
  const downloaded = await runDownloadPhase(job, deps);
  if (downloaded.done) return downloaded.snapshot;
  const pushed = await runPushPhase(job, deps, downloaded.value);
  if (pushed.done) return pushed.snapshot;
  return (await runStartPhase(job, deps, downloaded.value)).snapshot;
}

async function runDownloadPhase(
  job: Job,
  deps: JobDeps
): Promise<PhaseContinue<DownloadedRelease> | PhaseEnd> {
  job.phase = 'download';
  try {
    const downloaded = await withTimeout(
      deps.download(job.version, job.abort.signal),
      deps.timeouts.downloadMs,
      'download timeout'
    );
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      return { done: true, snapshot: markCancelled(job, deps.nowFn) };
    }
    return { done: false, value: downloaded };
  } catch (err) {
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      return { done: true, snapshot: markCancelled(job, deps.nowFn) };
    }
    return {
      done: true,
      snapshot: fail(job, `download failed: ${errorMessage(err)}`, deps.nowFn),
    };
  }
}

function supportsStagedResume(job: Job): boolean {
  return job.upgradeCapabilities.includes('staged-package-resume');
}

function backoffMs(attempt: number): number {
  return (
    PUSH_RETRY_BACKOFF_MS[attempt - 1] ??
    PUSH_RETRY_BACKOFF_MS[PUSH_RETRY_BACKOFF_MS.length - 1] ??
    15000
  );
}

/** 一次推送尝试的结论。`retry` 判定为链路问题，可以退避后接着补发。 */
type PushAttempt =
  | { kind: 'landed' }
  | { kind: 'retry'; error: string }
  | { kind: 'fail'; error: string }
  | { kind: 'cancelled'; snapshot: RemoteUpgradeJobSnapshot };

/**
 * 推包阶段。目标支持 `staged-package-resume` 时先问一次已收偏移，只补发缺的那一段；
 * 链路断掉（中继复位 / 顶号 / 上行切换）退避重试，整个阶段共用 `pushMs` 预算。
 */
async function runPushPhase(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease
): Promise<PhaseEnd | { done: false }> {
  job.phase = 'push';
  job.totalBytes = downloaded.bytes;
  const resume = supportsStagedResume(job);
  const maxAttempts = resume ? PUSH_MAX_ATTEMPTS : LEGACY_PUSH_MAX_ATTEMPTS;
  const deadline = deps.nowFn() + deps.timeouts.pushMs;
  let lastError = 'push failed: push timeout';
  let fullReupload = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    job.attempt = attempt;
    const status =
      resume && !fullReupload ? await readPushedOffset(job, deps, downloaded) : NO_STAGED_OFFSET;
    if (status.complete) {
      job.pushed = true;
      job.pushedBytes = downloaded.bytes;
      return { done: false };
    }
    const offset = Math.min(status.offset, downloaded.bytes);
    job.pushedBytes = offset;
    const result = await attemptPush(job, deps, downloaded, offset, deadline);
    if (result.kind === 'landed') {
      job.pushed = true;
      job.pushedBytes = downloaded.bytes;
      return { done: false };
    }
    if (result.kind === 'cancelled') return { done: true, snapshot: result.snapshot };
    if (result.kind === 'fail') {
      if (!shouldReuploadFromZero(result.error, offset, fullReupload)) {
        return { done: true, snapshot: fail(job, result.error, deps.nowFn) };
      }
      fullReupload = true;
    }
    lastError = result.error;
    if (attempt >= maxAttempts || deps.nowFn() >= deadline) break;
    if (!(await backoff(job, deps, attempt))) {
      return { done: true, snapshot: await cancelPush(job, deps) };
    }
    if (deps.nowFn() >= deadline) break;
  }
  return { done: true, snapshot: fail(job, lastError, deps.nowFn) };
}

/** 盘上的半成品与 sha 对不上：续传救不回来，整包重传一次（只退一次，避免来回刷带宽）。 */
function shouldReuploadFromZero(error: string, offset: number, alreadyRetried: boolean): boolean {
  return !alreadyRetried && offset > 0 && error.includes('PACKAGE_SHA256_MISMATCH');
}

async function backoff(job: Job, deps: JobDeps, attempt: number): Promise<boolean> {
  try {
    await deps.sleep(backoffMs(attempt), job.abort.signal);
  } catch {
    return false;
  }
  return !job.abort.signal.aborted && !isCancelled(job);
}

async function cancelPush(job: Job, deps: JobDeps): Promise<RemoteUpgradeJobSnapshot> {
  if (isCancelled(job)) return snapshotOf(job);
  await deleteStagedBestEffort(job, deps.req, deps.forward);
  return markCancelled(job, deps.nowFn);
}

/** 目标那边的暂存进度。`complete` 只在正式暂存包已落位时为真。 */
type StagedOffset = { offset: number; complete: boolean };

const NO_STAGED_OFFSET: StagedOffset = { offset: 0, complete: false };

/**
 * 查目标已收到多少字节；查不动就当 0（从头重传，最坏也只是多花一次带宽）。
 * `receivedBytes === totalBytes` 但 `complete === false` 表示 `.part` 写满了却没提交：
 * 仍要发一次零长度 PUT 让目标校验 sha256 并提交，不能当成已推完直接启动升级。
 */
async function readPushedOffset(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease
): Promise<StagedOffset> {
  try {
    const res = await withTimeout(
      deps.forward.forwardAuthorizedHttp(deps.req, {
        nodeId: job.nodeId,
        method: 'GET',
        path: '/api/system/upgrade/package',
        query: `?version=${encodeURIComponent(job.version)}&sha256=${downloaded.sha256}`,
        signal: job.abort.signal,
      }),
      OFFSET_QUERY_TIMEOUT_MS,
      'offset timeout'
    );
    const text = await res.text().catch(() => '');
    if (res.status < 200 || res.status >= 300) return NO_STAGED_OFFSET;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return NO_STAGED_OFFSET;
    const row = parsed as { receivedBytes?: unknown; complete?: unknown };
    if (row.complete === true) return { offset: downloaded.bytes, complete: true };
    const received = typeof row.receivedBytes === 'number' ? row.receivedBytes : 0;
    if (!Number.isFinite(received) || received < 0) return NO_STAGED_OFFSET;
    return { offset: Math.min(Math.trunc(received), downloaded.bytes), complete: false };
  } catch {
    return NO_STAGED_OFFSET;
  }
}

async function attemptPush(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease,
  offset: number,
  deadline: number
): Promise<PushAttempt> {
  const remaining = deadline - deps.nowFn();
  if (remaining <= 0) return { kind: 'retry', error: 'push failed: push timeout' };
  let fileStream: ReadableStream<Uint8Array> | null = null;
  try {
    fileStream = fileReadableStream(downloaded.path, offset);
    job.fileStream = fileStream;
    const pushReq = deps.forward.forwardAuthorizedHttp(deps.req, {
      nodeId: job.nodeId,
      method: 'PUT',
      path: '/api/system/upgrade/package',
      query: pushQuery(job.version, downloaded.sha256, offset),
      rawBody: fileStream,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(downloaded.bytes - offset),
      },
      signal: combineAbortSignals(AbortSignal.timeout(remaining), job.abort.signal),
      onProgress: (uploaded) => {
        job.pushedBytes = Math.min(offset + uploaded, downloaded.bytes);
      },
    });
    job.pushPromise = pushReq;
    const pushed = await withTimeout(pushReq, remaining, 'push timeout');
    fileStream = null;
    job.fileStream = null;
    return await classifyPushResponse(job, deps, pushed);
  } catch (err) {
    await fileStream?.cancel().catch(() => {});
    job.fileStream = null;
    if (isCancelled(job)) return { kind: 'cancelled', snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      return { kind: 'cancelled', snapshot: await cancelPush(job, deps) };
    }
    const message = errorMessage(err);
    return {
      kind: 'retry',
      error: `push failed: ${message.includes('push timeout') ? 'push timeout' : message}`,
    };
  }
}

function pushQuery(version: string, sha256: string, offset: number): string {
  const base = `?version=${encodeURIComponent(version)}&sha256=${sha256}`;
  return offset > 0 ? `${base}&offset=${offset}` : base;
}

async function classifyPushResponse(
  job: Job,
  deps: JobDeps,
  pushed: Response
): Promise<PushAttempt> {
  if (isCancelled(job)) {
    await pushed.text().catch(() => '');
    return { kind: 'cancelled', snapshot: snapshotOf(job) };
  }
  if (pushed.status >= 200 && pushed.status < 300) {
    // 小 JSON 回包读完再走，`body.cancel()` 会给转发层一个假的 aborted 结论。
    await pushed.text().catch(() => '');
    return { kind: 'landed' };
  }
  if (job.abort.signal.aborted) {
    await pushed.text().catch(() => '');
    return { kind: 'cancelled', snapshot: await cancelPush(job, deps) };
  }
  const detail = await describeUpstream(pushed);
  const error = `push failed: ${detail}`;
  return retryablePushStatus(pushed.status, detail)
    ? { kind: 'retry', error }
    : { kind: 'fail', error };
}

/**
 * 链路类失败才重试：入口连不上目标（503 NODE_UNREACHABLE）、网关级 5xx，
 * 以及偏移对不上（目标那边的 `.part` 被清了，下一轮重新问偏移即可）。
 */
function retryablePushStatus(status: number, detail: string): boolean {
  if (detail.includes('UPGRADE_OFFSET_MISMATCH')) return true;
  return status >= 500;
}

async function runStartPhase(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease
): Promise<PhaseEnd> {
  const { req, forward, timeouts, nowFn } = deps;
  job.phase = 'start';
  if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
  if (job.abort.signal.aborted) {
    if (supportsUpgradeCancel(job)) {
      await deleteStagedBestEffort(job, req, forward);
      return { done: true, snapshot: markCancelled(job, nowFn) };
    }
  }
  try {
    const startReq = forward.forwardAuthorizedHttp(req, {
      nodeId: job.nodeId,
      method: 'POST',
      path: '/api/system/upgrade',
      body: { version: job.version, source: 'staged', sha256: downloaded.sha256 },
      signal: AbortSignal.timeout(timeouts.startMs),
    });
    job.startPromise = startReq;
    const started = await withTimeout(startReq, timeouts.startMs, 'start timeout');
    if (isCancelled(job)) {
      await started.text().catch(() => '');
      return { done: true, snapshot: snapshotOf(job) };
    }
    if (started.status < 200 || started.status >= 300) {
      return {
        done: true,
        snapshot: fail(job, `start failed: ${await describeUpstream(started)}`, nowFn),
      };
    }
    await started.text().catch(() => '');
  } catch (err) {
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    const message = errorMessage(err);
    return {
      done: true,
      snapshot: fail(
        job,
        `start failed: ${message.includes('start timeout') ? 'start timeout' : message}`,
        nowFn
      ),
    };
  }

  if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
  job.state = 'handed-off';
  job.error = null;
  return { done: true, snapshot: snapshotOf(job) };
}

function markCancelled(job: Job, nowFn: () => number = Date.now): RemoteUpgradeJobSnapshot {
  if (job.state === 'handed-off') return snapshotOf(job);
  if (job.state !== 'cancelled') {
    job.state = 'cancelled';
    job.error = UPGRADE_CANCELLED;
    job.failedAt = new Date(nowFn()).toISOString();
  }
  return snapshotOf(job);
}

function fail(job: Job, error: string, nowFn: () => number = Date.now): RemoteUpgradeJobSnapshot {
  if (job.state === 'cancelled' || job.state === 'handed-off') return snapshotOf(job);
  job.state = 'failed';
  job.error = error;
  job.failedAt = new Date(nowFn()).toISOString();
  return snapshotOf(job);
}

async function deleteStagedBestEffort(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward
): Promise<void> {
  try {
    const res = await forward.forwardAuthorizedHttp(req, {
      nodeId: job.nodeId,
      method: 'DELETE',
      path: '/api/system/upgrade/package',
      query: `?version=${encodeURIComponent(job.version)}`,
      retry: { attempts: 2 },
    });
    await res.text().catch(() => '');
    if (res.status < 200 || res.status >= 300) {
      console.warn(
        `[mesh][upgrade] cancel staged package failed node=${job.nodeId} version=${job.version} status=${res.status}`
      );
    }
  } catch (err) {
    const detail = errorMessage(err);
    console.warn(
      `[mesh][upgrade] cancel staged package failed node=${job.nodeId} version=${job.version} err=${detail}`
    );
  }
}

function snapshotOf(job: Job): RemoteUpgradeJobSnapshot {
  return {
    state: job.state,
    targetVersion: job.version,
    error: job.error,
    startedAt: job.startedAt,
    phase: job.phase,
    pushedBytes: job.pushedBytes,
    totalBytes: job.totalBytes,
    attempt: job.attempt,
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function defaultDownload(version: string, signal?: AbortSignal): Promise<DownloadedRelease> {
  return downloadVerifiedRelease(version, {
    cacheDir: resolveReleaseCacheDir(resolveUpgradeInstallDir(getInstallInfo())),
    signal,
  });
}

function detachRequest(req: Request): Request {
  const headers = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const origin = req.headers.get('origin');
  if (origin) headers.set('origin', origin);
  return new Request(req.url, { headers });
}

/** `start` 用于续传：只读没推过去的那一段。 */
function fileReadableStream(path: string, start = 0): ReadableStream<Uint8Array> {
  const size = statSync(path).size;
  if (size === 0 || start >= size) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }
  return Readable.toWeb(
    start > 0 ? createReadStream(path, { start }) : createReadStream(path)
  ) as unknown as ReadableStream<Uint8Array>;
}

async function describeUpstream(res: Response): Promise<string> {
  const text = (await res.text().catch(() => '')).slice(0, 800);
  let extra = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const code = (parsed as { code?: unknown }).code;
      const error = (parsed as { error?: unknown }).error;
      extra = [typeof code === 'string' ? code : null, typeof error === 'string' ? error : null]
        .filter(Boolean)
        .join(' ');
    }
  } catch {
    // keep raw text
  }
  return `HTTP ${res.status}${extra ? ` ${extra}` : ''}`.trim();
}
