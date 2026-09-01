import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
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

export type RemoteUpgradeJobState = 'running' | 'failed' | 'handed-off';

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
};

type RemoteUpgradeTimeouts = {
  downloadMs: number;
  pushMs: number;
  startMs: number;
};

const jobs = new Map<string, Job>();
const downloadInflight = new Map<string, Promise<DownloadedRelease>>();

export function resetRemoteUpgradeJobsForTests(): void {
  jobs.clear();
  downloadInflight.clear();
}

export function getRemoteUpgradeJob(
  nodeId: string,
  now = Date.now()
): RemoteUpgradeJobSnapshot | null {
  const job = jobs.get(nodeId);
  if (!job) return null;
  if (job.state === 'failed') {
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
  download?: (version: string) => Promise<DownloadedRelease>;
  now?: () => number;
  timeouts?: Partial<RemoteUpgradeTimeouts>;
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

async function runJob(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward,
  download: (version: string) => Promise<DownloadedRelease>,
  timeouts: RemoteUpgradeTimeouts,
  nowFn: () => number
): Promise<RemoteUpgradeJobSnapshot> {
  let downloaded: DownloadedRelease;
  try {
    downloaded = await withTimeout(
      sharedDownload(job.version, download),
      timeouts.downloadMs,
      'download timeout'
    );
  } catch (err) {
    return fail(job, `download failed: ${err instanceof Error ? err.message : String(err)}`, nowFn);
  }

  let fileStream: ReadableStream<Uint8Array> | null = null;
  try {
    fileStream = fileReadableStream(downloaded.path);
    const pushed = await withTimeout(
      forward.forwardAuthorizedHttp(req, {
        nodeId: job.nodeId,
        method: 'PUT',
        path: '/api/system/upgrade/package',
        query: `?version=${encodeURIComponent(job.version)}&sha256=${downloaded.sha256}`,
        rawBody: fileStream,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(downloaded.bytes),
        },
        signal: AbortSignal.timeout(timeouts.pushMs),
      }),
      timeouts.pushMs,
      'push timeout'
    );
    fileStream = null;
    if (pushed.status < 200 || pushed.status >= 300) {
      return fail(job, `push failed: ${await describeUpstream(pushed)}`, nowFn);
    }
    await pushed.body?.cancel().catch(() => {});
  } catch (err) {
    await fileStream?.cancel().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      job,
      `push failed: ${message.includes('push timeout') ? 'push timeout' : message}`,
      nowFn
    );
  }

  try {
    const started = await withTimeout(
      forward.forwardAuthorizedHttp(req, {
        nodeId: job.nodeId,
        method: 'POST',
        path: '/api/system/upgrade',
        body: { version: job.version, source: 'staged', sha256: downloaded.sha256 },
        signal: AbortSignal.timeout(timeouts.startMs),
      }),
      timeouts.startMs,
      'start timeout'
    );
    if (started.status < 200 || started.status >= 300) {
      return fail(job, `start failed: ${await describeUpstream(started)}`, nowFn);
    }
    await started.body?.cancel().catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      job,
      `start failed: ${message.includes('start timeout') ? 'start timeout' : message}`,
      nowFn
    );
  }

  job.state = 'handed-off';
  job.error = null;
  return snapshotOf(job);
}

function fail(job: Job, error: string, nowFn: () => number = Date.now): RemoteUpgradeJobSnapshot {
  job.state = 'failed';
  job.error = error;
  job.failedAt = new Date(nowFn()).toISOString();
  return snapshotOf(job);
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

function sharedDownload(
  version: string,
  download: (version: string) => Promise<DownloadedRelease>
): Promise<DownloadedRelease> {
  const existing = downloadInflight.get(version);
  if (existing) return existing;
  const pending = download(version).finally(() => {
    if (downloadInflight.get(version) === pending) downloadInflight.delete(version);
  });
  downloadInflight.set(version, pending);
  return pending;
}

async function defaultDownload(version: string): Promise<DownloadedRelease> {
  return downloadVerifiedRelease(version, {
    cacheDir: resolveReleaseCacheDir(resolveUpgradeInstallDir(getInstallInfo())),
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
