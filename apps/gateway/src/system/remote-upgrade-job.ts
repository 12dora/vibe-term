import {
  type RemoteUpgradeChannel,
  UPGRADE_CANCELLED,
  combineAbortSignals,
  errorMessage,
  selectReleaseAssetForTarget,
  withTimeout,
} from '@vibeterm/shared';
import {
  PUSH_MAX_ATTEMPTS,
  PUSH_RETRY_BACKOFF_MS,
  type PushOutcome,
  type PushPutOptions,
  type PushTransport,
  runPush,
} from '@vibeterm/transfer';
import { openRange } from '@vibeterm/transfer/node';
import { type DownloadProgressFn, retainReleaseVersion } from './release-download';
import { ReleaseSignatureError, assertPushableRelease } from './release-signature';
import {
  type DeliveryStepResult,
  initialUpgradeChannel,
  initialUpgradePhase,
  jobCapabilities,
  runNodeGithubChannel,
  runUpgradeDelivery,
  stepFromSnapshot,
} from './remote-upgrade-delivery';
import {
  abortableSleep,
  classifyUpgradePushResponse,
  consumeBoundedBody,
  defaultReleaseDownload,
  deleteStagedBestEffort,
  describeUpstream,
  detachRequest,
  parseStagedStatusBody,
  pushPackageManifest,
  pushPackageQuery,
  rangedPushPlan,
  releaseCacheDir,
} from './remote-upgrade-io';
import type { AuthorizedUpgradeForward } from './upgrade-service';

const FAILED_TTL_MS = 10 * 60 * 1000;

export const REMOTE_UPGRADE_TIMEOUTS = {
  downloadMs: 10 * 60 * 1000,
  pushMs: 15 * 60 * 1000,
  startMs: 60 * 1000,
};

// 退避梯度与「支持续传时推几次」是引擎的策略，这里只做转出，不再留第二份定义。
export { PUSH_MAX_ATTEMPTS, PUSH_RETRY_BACKOFF_MS } from '@vibeterm/transfer';
/** 目标不支持续传：重传只能从头来，最多 3 次，且只在链路断了才重试。升级独有。 */
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
  channel: RemoteUpgradeChannel;
  /** 目标已确认收到的字节数 */
  pushedBytes: number;
  /** 升级包总字节数；下载完成前为 0 */
  totalBytes: number;
  /** 入口已从发行源下载的字节数 */
  downloadedBytes: number;
  /** 发行源给出的下载总量；没有 `content-length` 时为 0 */
  downloadTotalBytes: number;
  /** 当前是第几次推送尝试，从 1 起 */
  attempt: number;
};

export type RemoteUpgradeJobState = 'running' | 'failed' | 'handed-off' | 'cancelled';

export type RemoteUpgradeStartResult =
  | { ok: true; snapshot: RemoteUpgradeJobSnapshot }
  | { ok: false; code: 'UPGRADE_IN_PROGRESS' };

type DownloadedRelease = {
  path: string;
  sha256: string;
  bytes: number;
  /** 已验签的 SHA256SUMS 原文，随清单交给目标。 */
  sums: string;
  /** 签名行；缺失表示这一版没有签名，一律不推。 */
  sig: string | null;
};

type DownloadFn = (
  version: string,
  signal?: AbortSignal,
  onProgress?: DownloadProgressFn,
  assetName?: string
) => Promise<DownloadedRelease>;

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
  channel: RemoteUpgradeChannel;
  pushed: boolean;
  pushedBytes: number;
  totalBytes: number;
  downloadedBytes: number;
  downloadTotalBytes: number;
  attempt: number;
  fileStream: ReadableStream<Uint8Array> | null;
  pushPromise: Promise<Response> | null;
  startPromise: Promise<Response> | null;
  upgradeCapabilities: string[];
  /** 推给目标节点的发行资产名：<2.0.0 的节点只认改名前的那份。 */
  assetName: string;
  pushStreams?: number;
  pushChunkBytes?: number;
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
  download?: DownloadFn;
  now?: () => number;
  timeouts?: Partial<RemoteUpgradeTimeouts>;
  upgradeCapabilities?: readonly string[];
  /** 目标节点当前版本；决定推新资产还是改名前的旧资产。未知时按旧资产处理。 */
  targetCurrentVersion?: string | null;
  /** 单测注入：跳过退避真实等待。 */
  sleep?: SleepFn;
  /** 单测注入：覆盖乱序推包的流数 / 分片；生产默认 4 流 × 4 MiB，上限 8 流。 */
  pushStreams?: number;
  pushChunkBytes?: number;
}): RemoteUpgradeStartResult {
  const existing = jobs.get(opts.nodeId);
  if (existing?.state === 'running') return { ok: false, code: 'UPGRADE_IN_PROGRESS' };

  const nowFn = opts.now ?? Date.now;
  const startedAt = new Date(nowFn()).toISOString();
  const detached = detachRequest(opts.req);
  const capabilities = jobCapabilities(opts.upgradeCapabilities);
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
    phase: initialUpgradePhase(capabilities),
    channel: initialUpgradeChannel(capabilities),
    pushed: false,
    pushedBytes: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    downloadTotalBytes: 0,
    attempt: 0,
    fileStream: null,
    pushPromise: null,
    startPromise: null,
    upgradeCapabilities: capabilities,
    assetName: selectReleaseAssetForTarget(opts.targetCurrentVersion, opts.version),
    pushStreams: opts.pushStreams,
    pushChunkBytes: opts.pushChunkBytes,
  };
  jobs.set(opts.nodeId, job);

  const download = opts.download ?? defaultReleaseDownload;
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
    sleep: opts.sleep ?? abortableSleep,
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
    await dropStaged(job, opts.req, opts.forward);
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
    await dropStaged(job, opts.req, opts.forward);
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
  await dropStaged(job, req, forward);
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
  download: DownloadFn;
  timeouts: RemoteUpgradeTimeouts;
  nowFn: () => number;
  sleep: SleepFn;
};

async function runJob(job: Job, deps: JobDeps): Promise<RemoteUpgradeJobSnapshot> {
  const releaseLease = retainReleaseVersion(releaseCacheDir(), job.version);
  try {
    return await runUpgradeDelivery({
      hasSpeedProbe: job.upgradeCapabilities.includes('release-speed-probe'),
      hasStagedPackage: job.upgradeCapabilities.includes('staged-package'),
      tryNodeGithub: (requireFast) =>
        runNodeGithubChannel({
          job,
          requireFastSource: requireFast,
          forward: deps.forward,
          req: deps.req,
          timeoutMs: deps.timeouts.startMs,
          snapshot: () => snapshotOf(job),
          fail: (error) => fail(job, error, deps.nowFn),
          markCancelled: () => markCancelled(job, deps.nowFn),
          isCancelled: () => isCancelled(job),
        }),
      runPushPipeline: () => runPushPipeline(job, deps),
      fail: (error) => fail(job, error, deps.nowFn),
    });
  } finally {
    releaseLease();
  }
}

async function runPushPipeline(
  job: Job,
  deps: JobDeps
): Promise<DeliveryStepResult<RemoteUpgradeJobSnapshot>> {
  job.channel = 'push';
  const downloaded = await runDownloadPhase(job, deps);
  if (downloaded.done)
    return stepFromSnapshot(job.state, job.channel, downloaded.snapshot, job.error);
  const pushed = await runPushPhase(job, deps, downloaded.value);
  if (pushed.done) return stepFromSnapshot(job.state, job.channel, pushed.snapshot, job.error);
  return { kind: 'done', snapshot: (await runStartPhase(job, deps, downloaded.value)).snapshot };
}

async function runDownloadPhase(
  job: Job,
  deps: JobDeps
): Promise<PhaseContinue<DownloadedRelease> | PhaseEnd> {
  job.phase = 'download';
  try {
    const downloaded = await withTimeout(
      deps.download(
        job.version,
        job.abort.signal,
        (downloadedBytes, totalBytes) => {
          job.downloadedBytes = downloadedBytes;
          job.downloadTotalBytes = totalBytes;
        },
        job.assetName
      ),
      deps.timeouts.downloadMs,
      'download timeout'
    );
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      return { done: true, snapshot: markCancelled(job, deps.nowFn) };
    }
    // 推给别的节点的包必须是签过名的：目标离线也能自证这堆字节确实来自发布流水线。
    try {
      assertPushableRelease(job.version, downloaded);
    } catch (err) {
      const detail = err instanceof ReleaseSignatureError ? err.message : errorMessage(err);
      return { done: true, snapshot: fail(job, `download failed: ${detail}`, deps.nowFn) };
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

async function runPushPhase(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease
): Promise<PhaseEnd | { done: false }> {
  job.phase = 'push';
  job.totalBytes = downloaded.bytes;
  const manifest = await sendPackageManifest(job, deps, downloaded);
  if (!manifest.ok) {
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) return { done: true, snapshot: await cancelPush(job, deps) };
    return { done: true, snapshot: fail(job, manifest.error, deps.nowFn) };
  }
  const resume = supportsStagedResume(job);
  const { streams, maxRangeBytes, ranged } = rangedPushPlan({
    capabilities: job.upgradeCapabilities,
    streams: job.pushStreams,
    chunkBytes: job.pushChunkBytes,
  });
  const startedAt = deps.nowFn();
  const result = await runPush(pushTransport(job, deps, downloaded, ranged), {
    totalBytes: downloaded.bytes,
    streams,
    maxRangeBytes,
    resume,
    maxAttempts: resume ? PUSH_MAX_ATTEMPTS : LEGACY_PUSH_MAX_ATTEMPTS,
    backoffMs: PUSH_RETRY_BACKOFF_MS,
    deadlineMs: deps.nowFn() + deps.timeouts.pushMs,
    signal: job.abort.signal,
    now: deps.nowFn,
    sleep: deps.sleep,
    timeoutError: 'push failed: push timeout',
    onAttempt: (attempt) => {
      job.attempt = attempt;
    },
    onProgress: (bytes) => {
      const next = Math.min(Math.max(0, bytes), downloaded.bytes);
      if (next > job.pushedBytes) job.pushedBytes = next;
    },
    shouldRestartFromZero: shouldReuploadFromZero,
  });
  console.log(
    `[upgrade] push node=${job.nodeId} streams=${streams} bytes=${downloaded.bytes} ms=${deps.nowFn() - startedAt}`
  );
  if (result.kind === 'done') {
    job.pushed = true;
    job.pushedBytes = downloaded.bytes;
    return { done: false };
  }
  if (result.kind === 'cancelled') return { done: true, snapshot: await cancelPush(job, deps) };
  return { done: true, snapshot: fail(job, result.error, deps.nowFn) };
}

function sendPackageManifest(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!downloaded.sig) {
    return Promise.resolve({ ok: false, error: 'push failed: RELEASE_UNSIGNED' });
  }
  return pushPackageManifest({
    forward: deps.forward,
    req: deps.req,
    nodeId: job.nodeId,
    version: job.version,
    sums: downloaded.sums,
    sig: downloaded.sig,
    asset: job.assetName,
    signal: job.abort.signal,
  });
}

function pushTransport(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease,
  ranged: boolean
): PushTransport {
  return {
    async status() {
      const staged = await readPushedOffset(job, deps, downloaded);
      return {
        receivedBytes: staged.offset,
        ranges: staged.ranges,
        complete: staged.complete,
      };
    },
    put: (range, opts) => attemptPush(job, deps, downloaded, range, opts, ranged),
  };
}

/** 盘上的半成品与 sha 对不上：续传救不回来，整包重传一次（只退一次，避免来回刷带宽）。 */
function shouldReuploadFromZero(error: string, offset: number): boolean {
  return offset > 0 && error.includes('PACKAGE_SHA256_MISMATCH');
}

async function cancelPush(job: Job, deps: JobDeps): Promise<RemoteUpgradeJobSnapshot> {
  if (isCancelled(job)) return snapshotOf(job);
  await dropStaged(job, deps.req, deps.forward);
  return markCancelled(job, deps.nowFn);
}

/** 目标那边的暂存进度。`complete` 只在正式暂存包已落位时为真。 */
type StagedOffset = {
  offset: number;
  complete: boolean;
  ranges: Array<{ offset: number; length: number }>;
};

const NO_STAGED_OFFSET: StagedOffset = { offset: 0, complete: false, ranges: [] };

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
    const text = await consumeBoundedBody(res);
    if (res.status < 200 || res.status >= 300) return NO_STAGED_OFFSET;
    return parseStagedStatusBody(text, downloaded.bytes);
  } catch {
    return NO_STAGED_OFFSET;
  }
}

async function attemptPush(
  job: Job,
  deps: JobDeps,
  downloaded: DownloadedRelease,
  range: { offset: number; length: number },
  push: PushPutOptions,
  ranged: boolean
): Promise<PushOutcome> {
  const remaining = push.deadlineMs - deps.nowFn();
  if (remaining <= 0) return { kind: 'retry', error: 'push failed: push timeout' };
  let fileStream: ReadableStream<Uint8Array> | null = null;
  try {
    fileStream = openRange(downloaded.path, range.offset, range.offset + range.length);
    job.fileStream = fileStream;
    const pushReq = deps.forward.forwardAuthorizedHttp(deps.req, {
      nodeId: job.nodeId,
      method: 'PUT',
      path: '/api/system/upgrade/package',
      query: pushPackageQuery({
        version: job.version,
        sha256: downloaded.sha256,
        offset: range.offset,
        length: range.length,
        total: downloaded.bytes,
        ranged,
      }),
      rawBody: fileStream,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(range.length),
      },
      signal: combineAbortSignals(AbortSignal.timeout(remaining), push.signal),
      onProgress: (uploaded) => push.onProgress(uploaded),
    });
    job.pushPromise = pushReq;
    const pushed = await withTimeout(pushReq, remaining, 'push timeout');
    fileStream = null;
    job.fileStream = null;
    return await classifyUpgradePushResponse(pushed, {
      cancelled: isCancelled(job),
      aborted: job.abort.signal.aborted,
    });
  } catch (err) {
    await fileStream?.cancel().catch(() => {});
    job.fileStream = null;
    if (isCancelled(job) || job.abort.signal.aborted) return { kind: 'cancelled' };
    const message = errorMessage(err);
    return {
      kind: 'retry',
      error: `push failed: ${message.includes('push timeout') ? 'push timeout' : message}`,
    };
  }
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
      await dropStaged(job, req, forward);
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
      await consumeBoundedBody(started);
      return { done: true, snapshot: snapshotOf(job) };
    }
    if (started.status < 200 || started.status >= 300) {
      return {
        done: true,
        snapshot: fail(job, `start failed: ${await describeUpstream(started)}`, nowFn),
      };
    }
    await consumeBoundedBody(started);
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

function dropStaged(job: Job, req: Request, forward: AuthorizedUpgradeForward): Promise<void> {
  return deleteStagedBestEffort({ nodeId: job.nodeId, version: job.version, req, forward });
}

function snapshotOf(job: Job): RemoteUpgradeJobSnapshot {
  return {
    state: job.state,
    targetVersion: job.version,
    error: job.error,
    startedAt: job.startedAt,
    phase: job.phase,
    channel: job.channel,
    pushedBytes: job.pushedBytes,
    totalBytes: job.totalBytes,
    downloadedBytes: job.downloadedBytes,
    downloadTotalBytes: job.downloadTotalBytes,
    attempt: job.attempt,
  };
}
