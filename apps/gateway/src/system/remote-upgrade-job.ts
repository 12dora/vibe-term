import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getInstallInfo } from './install-info';
import { downloadVerifiedRelease } from './release-download';
import { resolveUpgradeInstallDir } from './upgrade';
import type { AuthorizedUpgradeForward } from './upgrade-service';

const FAILED_TTL_MS = 10 * 60 * 1000;

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
  state: RemoteUpgradeJobState;
  error: string | null;
  finished: Promise<RemoteUpgradeJobSnapshot>;
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
    const started = Date.parse(job.startedAt);
    if (!Number.isFinite(started) || now - started > FAILED_TTL_MS) {
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

export function startRemoteUpgradeJob(opts: {
  nodeId: string;
  version: string;
  req: Request;
  forward: AuthorizedUpgradeForward;
  download?: (version: string) => Promise<DownloadedRelease>;
  now?: () => number;
}): RemoteUpgradeStartResult {
  const existing = jobs.get(opts.nodeId);
  if (existing?.state === 'running') return { ok: false, code: 'UPGRADE_IN_PROGRESS' };

  const startedAt = new Date((opts.now ?? Date.now)()).toISOString();
  const detached = detachRequest(opts.req);
  let resolveFinished!: (snapshot: RemoteUpgradeJobSnapshot) => void;
  const finished = new Promise<RemoteUpgradeJobSnapshot>((resolve) => {
    resolveFinished = resolve;
  });
  const job: Job = {
    nodeId: opts.nodeId,
    version: opts.version,
    startedAt,
    state: 'running',
    error: null,
    finished,
  };
  jobs.set(opts.nodeId, job);

  const download = opts.download ?? defaultDownload;
  void runJob(job, detached, opts.forward, download).then((snapshot) => resolveFinished(snapshot));
  return { ok: true, snapshot: snapshotOf(job) };
}

async function runJob(
  job: Job,
  req: Request,
  forward: AuthorizedUpgradeForward,
  download: (version: string) => Promise<DownloadedRelease>
): Promise<RemoteUpgradeJobSnapshot> {
  let downloaded: DownloadedRelease;
  try {
    downloaded = await sharedDownload(job.version, download);
  } catch (err) {
    return fail(job, `download failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const rawBody = fileReadableStream(downloaded.path);
    const pushed = await forward.forwardAuthorizedHttp(req, {
      nodeId: job.nodeId,
      method: 'PUT',
      path: '/api/system/upgrade/package',
      query: `?version=${encodeURIComponent(job.version)}&sha256=${downloaded.sha256}`,
      rawBody,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(downloaded.bytes),
      },
    });
    if (pushed.status < 200 || pushed.status >= 300) {
      return fail(job, `push failed: ${await describeUpstream(pushed)}`);
    }
    await pushed.body?.cancel().catch(() => {});
  } catch (err) {
    return fail(job, `push failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const started = await forward.forwardAuthorizedHttp(req, {
      nodeId: job.nodeId,
      method: 'POST',
      path: '/api/system/upgrade',
      body: { version: job.version, source: 'staged', sha256: downloaded.sha256 },
    });
    if (started.status < 200 || started.status >= 300) {
      return fail(job, `start failed: ${await describeUpstream(started)}`);
    }
    await started.body?.cancel().catch(() => {});
  } catch (err) {
    return fail(job, `start failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  job.state = 'handed-off';
  job.error = null;
  return snapshotOf(job);
}

function fail(job: Job, error: string): RemoteUpgradeJobSnapshot {
  job.state = 'failed';
  job.error = error;
  return snapshotOf(job);
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
  return downloadVerifiedRelease(version, { cacheDir: resolveReleaseCacheDir() });
}

export function resolveReleaseCacheDir(): string {
  const override = process.env.TMEX_RELEASE_CACHE_DIR?.trim();
  if (override) return override;
  const installDir = resolveUpgradeInstallDir(getInstallInfo());
  if (installDir) return join(installDir, 'staging', 'release-cache');
  return join(tmpdir(), 'tmex-release-cache');
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
