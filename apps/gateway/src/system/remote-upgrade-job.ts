import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { UPGRADE_CANCELLED } from '@tmex/shared';
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

export type RemoteUpgradeJobState = 'running' | 'failed' | 'handed-off' | 'cancelled';

export type RemoteUpgradeJobSnapshot = {
  state: RemoteUpgradeJobState;
  targetVersion: string;
  error: string | null;
  startedAt: string;
};

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
  phase: 'download' | 'push' | 'start';
  pushed: boolean;
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
  void runJob(job, detached, opts.forward, download, timeouts, nowFn).then((snapshot) =>
    resolveFinished(snapshot)
  );
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

async function runJob(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward,
  download: (version: string, signal?: AbortSignal) => Promise<DownloadedRelease>,
  timeouts: RemoteUpgradeTimeouts,
  nowFn: () => number
): Promise<RemoteUpgradeJobSnapshot> {
  const downloaded = await runDownloadPhase(job, download, timeouts, nowFn);
  if (downloaded.done) return downloaded.snapshot;
  const pushed = await runPushPhase(job, req, forward, downloaded.value, timeouts, nowFn);
  if (pushed.done) return pushed.snapshot;
  return (await runStartPhase(job, req, forward, downloaded.value, timeouts, nowFn)).snapshot;
}

async function runDownloadPhase(
  job: Job,
  download: (version: string, signal?: AbortSignal) => Promise<DownloadedRelease>,
  timeouts: RemoteUpgradeTimeouts,
  nowFn: () => number
): Promise<PhaseContinue<DownloadedRelease> | PhaseEnd> {
  job.phase = 'download';
  try {
    const downloaded = await withTimeout(
      download(job.version, job.abort.signal),
      timeouts.downloadMs,
      'download timeout'
    );
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      return { done: true, snapshot: markCancelled(job, nowFn) };
    }
    return { done: false, value: downloaded };
  } catch (err) {
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      return { done: true, snapshot: markCancelled(job, nowFn) };
    }
    return {
      done: true,
      snapshot: fail(
        job,
        `download failed: ${err instanceof Error ? err.message : String(err)}`,
        nowFn
      ),
    };
  }
}

async function runPushPhase(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward,
  downloaded: DownloadedRelease,
  timeouts: RemoteUpgradeTimeouts,
  nowFn: () => number
): Promise<PhaseEnd | { done: false }> {
  let fileStream: ReadableStream<Uint8Array> | null = null;
  job.phase = 'push';
  try {
    fileStream = fileReadableStream(downloaded.path);
    job.fileStream = fileStream;
    const pushReq = forward.forwardAuthorizedHttp(req, {
      nodeId: job.nodeId,
      method: 'PUT',
      path: '/api/system/upgrade/package',
      query: `?version=${encodeURIComponent(job.version)}&sha256=${downloaded.sha256}`,
      rawBody: fileStream,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(downloaded.bytes),
      },
      signal: mergeAbortSignals(AbortSignal.timeout(timeouts.pushMs), job.abort.signal),
    });
    job.pushPromise = pushReq;
    const pushed = await withTimeout(pushReq, timeouts.pushMs, 'push timeout');
    fileStream = null;
    job.fileStream = null;
    if (isCancelled(job)) {
      await pushed.body?.cancel().catch(() => {});
      return { done: true, snapshot: snapshotOf(job) };
    }
    if (pushed.status < 200 || pushed.status >= 300) {
      if (job.abort.signal.aborted) {
        await deleteStagedBestEffort(job, req, forward);
        return { done: true, snapshot: markCancelled(job, nowFn) };
      }
      return {
        done: true,
        snapshot: fail(job, `push failed: ${await describeUpstream(pushed)}`, nowFn),
      };
    }
    await pushed.body?.cancel().catch(() => {});
    job.pushed = true;
    return { done: false };
  } catch (err) {
    await fileStream?.cancel().catch(() => {});
    job.fileStream = null;
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    if (job.abort.signal.aborted) {
      await deleteStagedBestEffort(job, req, forward);
      return { done: true, snapshot: markCancelled(job, nowFn) };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      done: true,
      snapshot: fail(
        job,
        `push failed: ${message.includes('push timeout') ? 'push timeout' : message}`,
        nowFn
      ),
    };
  }
}

async function runStartPhase(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward,
  downloaded: DownloadedRelease,
  timeouts: RemoteUpgradeTimeouts,
  nowFn: () => number
): Promise<PhaseEnd> {
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
      await started.body?.cancel().catch(() => {});
      return { done: true, snapshot: snapshotOf(job) };
    }
    if (started.status < 200 || started.status >= 300) {
      return {
        done: true,
        snapshot: fail(job, `start failed: ${await describeUpstream(started)}`, nowFn),
      };
    }
    await started.body?.cancel().catch(() => {});
  } catch (err) {
    if (isCancelled(job)) return { done: true, snapshot: snapshotOf(job) };
    const message = err instanceof Error ? err.message : String(err);
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
    });
    await res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 300) {
      console.warn(
        `[mesh][upgrade] cancel staged package failed node=${job.nodeId} version=${job.version} status=${res.status}`
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[mesh][upgrade] cancel staged package failed node=${job.nodeId} version=${job.version} err=${detail}`
    );
  }
}

function mergeAbortSignals(timeout: AbortSignal, user: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, user]);
  if (user.aborted) return user;
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  timeout.addEventListener('abort', onAbort, { once: true });
  user.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function snapshotOf(job: Job): RemoteUpgradeJobSnapshot {
  return {
    state: job.state,
    targetVersion: job.version,
    error: job.error,
    startedAt: job.startedAt,
  };
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

function fileReadableStream(path: string): ReadableStream<Uint8Array> {
  const size = statSync(path).size;
  if (size === 0) {
    return new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
  }
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
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
