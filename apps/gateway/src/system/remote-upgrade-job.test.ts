import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallInfo } from './install-info';
import { downloadVerifiedRelease, resetReleaseDownloadForTests } from './release-download';
import {
  LEGACY_PUSH_MAX_ATTEMPTS,
  PUSH_MAX_ATTEMPTS,
  cancelRemoteUpgradeJob,
  getRemoteUpgradeJob,
  resetRemoteUpgradeJobsForTests,
  startRemoteUpgradeJob,
  waitForRemoteUpgradeJob,
} from './remote-upgrade-job';
import { UpgradeController } from './upgrade';
import type { AuthorizedUpgradeForward } from './upgrade-service';

const tempDirs: string[] = [];
const originalReleaseCacheDir = process.env.TMEX_RELEASE_CACHE_DIR;

afterEach(() => {
  resetRemoteUpgradeJobsForTests();
  resetReleaseDownloadForTests();
  if (originalReleaseCacheDir === undefined) delete process.env.TMEX_RELEASE_CACHE_DIR;
  else process.env.TMEX_RELEASE_CACHE_DIR = originalReleaseCacheDir;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-job-pkg-'));
  tempDirs.push(dir);
  const path = join(dir, 'tmex-cli-9.9.9.tgz');
  writeFileSync(path, bytes);
  return path;
}

/** 退避不真等：重试用例只关心次数与偏移。 */
async function noSleep(): Promise<void> {}

const RESUME_CAPS = ['staged-package', 'upgrade-cancel', 'staged-package-resume'];

function offsetResponse(receivedBytes: number, complete = false): Response {
  return new Response(JSON.stringify({ receivedBytes, complete }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function unreachable(): Response {
  return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', error: 'stream-aborted' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
}

function authed(nodeId: string): Request {
  return new Request('http://localhost/api/mesh/nodes/x/upgrade', {
    method: 'POST',
    headers: { cookie: `tmex_s_${nodeId}=remote-sid` },
  });
}

describe('RemoteUpgradeJob', () => {
  test('downloads, PUTs the tarball, POSTs staged, and hands off', async () => {
    const nodeId = 'aa'.repeat(16);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const path = tempFile(bytes);
    const sha256 = 'ab'.repeat(32);
    const calls: Array<{
      method: string;
      path: string;
      body?: unknown;
      headers?: Record<string, string>;
    }> = [];
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        const raw = input.rawBody ? await new Response(input.rawBody).bytes() : null;
        calls.push({
          method: input.method,
          path: input.path,
          body: input.body,
          headers: input.headers,
        });
        if (input.method === 'PUT') {
          expect(raw).toEqual(bytes);
          expect(input.headers?.['content-type']).toBe('application/octet-stream');
          expect(input.headers?.['content-length']).toBe(String(bytes.byteLength));
          expect(input.query).toContain('version=9.9.9');
          expect(input.query).toContain(`sha256=${sha256}`);
          return new Response(
            JSON.stringify({ version: '9.9.9', sha256, bytes: bytes.byteLength }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        }
        return new Response(
          JSON.stringify({
            state: 'downloading',
            targetVersion: '9.9.9',
            error: null,
            startedAt: '2026-09-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    };

    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256, bytes: bytes.byteLength }),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('expected start');
    expect(started.snapshot.state).toBe('running');
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('running');

    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'PUT /api/system/upgrade/package',
      'POST /api/system/upgrade',
    ]);
    expect(calls[1]?.body).toEqual({ version: '9.9.9', source: 'staged', sha256 });
  });

  test('two nodes share one download', async () => {
    const a = '11'.repeat(16);
    const b = '22'.repeat(16);
    const cacheDir = mkdtempSync(join(tmpdir(), 'tmex-job-share-'));
    tempDirs.push(cacheDir);
    process.env.TMEX_RELEASE_CACHE_DIR = cacheDir;
    const tarball = new Uint8Array([9, 8, 7]);
    const hex = createHash('sha256').update(tarball).digest('hex');
    let tarballHits = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('SHA256SUMS')) {
        return new Response(`${hex}  tmex-cli-1.0.0.tgz\n`, { status: 200 });
      }
      tarballHits += 1;
      return new Response(tarball, { status: 200 });
    }) as typeof fetch;
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp() {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    };
    try {
      startRemoteUpgradeJob({
        nodeId: a,
        version: '1.0.0',
        req: authed(a),
        forward,
        download: (version, signal) => downloadVerifiedRelease(version, { cacheDir, signal }),
      });
      startRemoteUpgradeJob({
        nodeId: b,
        version: '1.0.0',
        req: authed(b),
        forward,
        download: (version, signal) => downloadVerifiedRelease(version, { cacheDir, signal }),
      });
      await Promise.all([waitForRemoteUpgradeJob(a), waitForRemoteUpgradeJob(b)]);
      expect(tarballHits).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('download failure records which step failed', async () => {
    const nodeId = 'bb'.repeat(16);
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          throw new Error('should not forward');
        },
      },
      download: async () => {
        throw new Error('GitHub release tarball HTTP 403');
      },
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/download failed/i);
    expect(done.error).toContain('HTTP 403');
  });

  test('push failure records status and upstream code', async () => {
    const nodeId = 'cc'.repeat(16);
    const path = tempFile(new Uint8Array([1]));
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'PUT') {
            return new Response(JSON.stringify({ code: 'PACKAGE_SHA256_MISMATCH' }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          throw new Error(`unexpected ${input.method}`);
        },
      },
      download: async () => ({ path, sha256: 'ee'.repeat(32), bytes: 1 }),
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/push failed/i);
    expect(done.error).toContain('400');
    expect(done.error).toContain('PACKAGE_SHA256_MISMATCH');
  });

  test('推包中途断链：按目标报的偏移续传，只补发剩下的字节', async () => {
    const nodeId = '33'.repeat(16);
    const bytes = new Uint8Array(1024).map((_, i) => i % 251);
    const path = tempFile(bytes);
    const cut = 400;
    const puts: Array<{ query: string; sent: number }> = [];
    let offsetQueries = 0;
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
            offsetQueries += 1;
            return offsetResponse(offsetQueries === 1 ? 0 : cut);
          }
          if (input.method === 'PUT') {
            const raw = input.rawBody
              ? await new Response(input.rawBody).bytes()
              : new Uint8Array();
            puts.push({ query: input.query ?? '', sent: raw.byteLength });
            if (puts.length === 1) return unreachable();
            expect(raw).toEqual(bytes.subarray(cut));
            return new Response('{}', { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: noSleep,
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(puts).toHaveLength(2);
    expect(puts[0]?.query).not.toContain('offset=');
    expect(puts[0]?.sent).toBe(bytes.byteLength);
    expect(puts[1]?.query).toContain(`offset=${cut}`);
    expect(puts[1]?.sent).toBe(bytes.byteLength - cut);
  });

  test('目标报 complete：不再推一遍，直接进 start', async () => {
    const nodeId = '44'.repeat(16);
    const bytes = new Uint8Array(16).fill(1);
    const path = tempFile(bytes);
    const calls: string[] = [];
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push(`${input.method} ${input.path}`);
          if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
            return offsetResponse(bytes.byteLength, true);
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(calls).toEqual(['GET /api/system/upgrade/package', 'POST /api/system/upgrade']);
  });

  test('.part 写满但未提交：发一次零长度 PUT 让目标校验并提交', async () => {
    const nodeId = '77'.repeat(16);
    const bytes = new Uint8Array(128).fill(9);
    const path = tempFile(bytes);
    const calls: string[] = [];
    const puts: Array<{ query: string; sent: number; length?: string }> = [];
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push(`${input.method} ${input.path}`);
          if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
            return offsetResponse(bytes.byteLength, false);
          }
          if (input.method === 'PUT') {
            const raw = input.rawBody
              ? await new Response(input.rawBody).bytes()
              : new Uint8Array();
            puts.push({
              query: input.query ?? '',
              sent: raw.byteLength,
              length: input.headers?.['content-length'],
            });
            return new Response('{}', { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(calls).toEqual([
      'GET /api/system/upgrade/package',
      'PUT /api/system/upgrade/package',
      'POST /api/system/upgrade',
    ]);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.query).toContain(`offset=${bytes.byteLength}`);
    expect(puts[0]?.sent).toBe(0);
    expect(puts[0]?.length).toBe('0');
  });

  test('零长度收尾被判 sha 不符：退回整包重传一次', async () => {
    const nodeId = '88'.repeat(16);
    const bytes = new Uint8Array(96).fill(4);
    const path = tempFile(bytes);
    const puts: Array<{ query: string; sent: number }> = [];
    let offsetQueries = 0;
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
            offsetQueries += 1;
            return offsetResponse(bytes.byteLength, false);
          }
          if (input.method === 'PUT') {
            const raw = input.rawBody
              ? await new Response(input.rawBody).bytes()
              : new Uint8Array();
            puts.push({ query: input.query ?? '', sent: raw.byteLength });
            if (puts.length === 1) {
              return new Response(JSON.stringify({ code: 'PACKAGE_SHA256_MISMATCH' }), {
                status: 400,
                headers: { 'content-type': 'application/json' },
              });
            }
            return new Response('{}', { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(offsetQueries).toBe(1);
    expect(puts).toHaveLength(2);
    expect(puts[0]?.sent).toBe(0);
    expect(puts[1]?.query).not.toContain('offset=');
    expect(puts[1]?.sent).toBe(bytes.byteLength);
  });

  test('长传过程中快照的 pushedBytes 随上行进度增长', async () => {
    const nodeId = '99'.repeat(16);
    const bytes = new Uint8Array(192 * 1024).fill(6);
    const path = tempFile(bytes);
    const observed: number[] = [];
    let sawCallback = false;
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method !== 'PUT' || !input.rawBody) return new Response('{}', { status: 200 });
          sawCallback = typeof input.onProgress === 'function';
          const reader = input.rawBody.getReader();
          let uploaded = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            uploaded += value.byteLength;
            input.onProgress?.(uploaded);
            observed.push(getRemoteUpgradeJob(nodeId)?.pushedBytes ?? -1);
            await Bun.sleep(1);
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(sawCallback).toBe(true);
    expect(observed.length).toBeGreaterThanOrEqual(3);
    expect(observed[0]).toBeGreaterThan(0);
    expect(observed[0]).toBeLessThan(bytes.byteLength);
    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i] as number).toBeGreaterThan(observed[i - 1] as number);
    }
    expect(observed[observed.length - 1]).toBe(bytes.byteLength);
  });

  test('重试次数用尽：按最后一次失败原因收尾，快照带上进度', async () => {
    const nodeId = '55'.repeat(16);
    const bytes = new Uint8Array(256).fill(2);
    const path = tempFile(bytes);
    let puts = 0;
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
            return offsetResponse(64);
          }
          if (input.method === 'PUT') {
            puts += 1;
            await input.rawBody?.cancel().catch(() => {});
            return unreachable();
          }
          throw new Error(`unexpected ${input.method}`);
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toContain('push failed');
    expect(puts).toBe(PUSH_MAX_ATTEMPTS);
    expect(done.phase).toBe('push');
    expect(done.attempt).toBe(PUSH_MAX_ATTEMPTS);
    expect(done.pushedBytes).toBe(64);
    expect(done.totalBytes).toBe(bytes.byteLength);
  });

  test('退避期间按下停止：不再重试，并清掉目标上的半成品', async () => {
    const nodeId = '66'.repeat(16);
    const bytes = new Uint8Array(128).fill(3);
    const path = tempFile(bytes);
    let puts = 0;
    let deleted = 0;
    let sawFirstFailure!: () => void;
    const firstFailed = new Promise<void>((resolve) => {
      sawFirstFailure = resolve;
    });
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
          return offsetResponse(0);
        }
        if (input.method === 'PUT') {
          puts += 1;
          await input.rawBody?.cancel().catch(() => {});
          sawFirstFailure();
          return unreachable();
        }
        if (input.method === 'DELETE') {
          deleted += 1;
          return new Response('{}', { status: 200 });
        }
        throw new Error(`unexpected ${input.method}`);
      },
    };
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: async (_ms, signal) => {
        await firstFailed;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (signal.aborted) throw new Error('aborted');
      },
    });
    await firstFailed;
    const cancelled = await cancelRemoteUpgradeJob({ nodeId, req: authed(nodeId), forward });
    expect(cancelled.handled).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('cancelled');
    expect(puts).toBeLessThan(PUSH_MAX_ATTEMPTS);
    expect(deleted).toBeGreaterThan(0);
  }, 8_000);

  test('不支持续传的目标：从零重传，且不问偏移', async () => {
    const nodeId = '77'.repeat(16);
    const bytes = new Uint8Array(96).fill(4);
    const path = tempFile(bytes);
    const sent: number[] = [];
    let offsetQueries = 0;
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'GET' && input.path === '/api/system/upgrade/package') {
            offsetQueries += 1;
            return offsetResponse(0);
          }
          if (input.method === 'PUT') {
            const raw = input.rawBody
              ? await new Response(input.rawBody).bytes()
              : new Uint8Array();
            sent.push(raw.byteLength);
            expect(input.query).not.toContain('offset=');
            return sent.length < 3 ? unreachable() : new Response('{}', { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: bytes.byteLength }),
      upgradeCapabilities: ['staged-package', 'upgrade-cancel'],
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
    expect(sent).toEqual([96, 96, 96]);
    expect(offsetQueries).toBe(0);
  });

  test('4xx 是确定性失败：一次就收尾，不重试', async () => {
    const nodeId = '88'.repeat(16);
    const path = tempFile(new Uint8Array([1, 2]));
    let puts = 0;
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'GET') return offsetResponse(0);
          puts += 1;
          return new Response(JSON.stringify({ code: 'PACKAGE_SHA256_MISMATCH' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: 2 }),
      upgradeCapabilities: RESUME_CAPS,
      sleep: noSleep,
    });
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(puts).toBe(1);
  });

  test('a second start while a job is running is UPGRADE_IN_PROGRESS', async () => {
    const nodeId = 'dd'.repeat(16);
    const path = tempFile(new Uint8Array([1]));
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp() {
        return new Response('{}', { status: 200 });
      },
    };
    const first = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => {
        await gate;
        return { path, sha256: 'ff'.repeat(32), bytes: 1 };
      },
    });
    expect(first.ok).toBe(true);
    const second = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'ff'.repeat(32), bytes: 1 }),
    });
    expect(second).toEqual({ ok: false, code: 'UPGRADE_IN_PROGRESS' });
    releaseDownload();
    await waitForRemoteUpgradeJob(nodeId);
  });

  test('push NODE_UNREACHABLE includes the underlying forwarder error', async () => {
    const nodeId = 'dd'.repeat(16);
    const path = tempFile(new Uint8Array([1, 2, 3]));
    let pushes = 0;
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'PUT') pushes += 1;
          return new Response(
            JSON.stringify({
              code: 'NODE_UNREACHABLE',
              nodeId,
              error: 'websocket send discarded',
            }),
            { status: 503, headers: { 'content-type': 'application/json' } }
          );
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: 3 }),
      sleep: noSleep,
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toBe('push failed: HTTP 503 NODE_UNREACHABLE websocket send discarded');
    // 旧目标不支持续传：链路断了也只从零重传两次，不无限重来。
    expect(pushes).toBe(LEGACY_PUSH_MAX_ATTEMPTS);
  });

  test('a push that never responds fails with push timeout and frees the node', async () => {
    const nodeId = 'ee'.repeat(16);
    const path = tempFile(new Uint8Array([1]));
    let cancelled = false;
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.rawBody) {
            input.rawBody.cancel = (async () => {
              cancelled = true;
            }) as typeof input.rawBody.cancel;
          }
          await new Promise(() => {});
          return new Response('never');
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: 1 }),
      timeouts: { pushMs: 50 },
    });
    expect(started.ok).toBe(true);
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/push timeout/i);
    const again = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: 1 }),
    });
    expect(again.ok).toBe(true);
    await waitForRemoteUpgradeJob(nodeId);
    expect(cancelled).toBe(true);
  });

  test('failed job TTL is measured from failedAt not startedAt', async () => {
    const nodeId = 'ff'.repeat(16);
    let now = Date.parse('2026-09-01T00:00:00.000Z');
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          throw new Error('should not forward');
        },
      },
      download: async () => {
        now += 9 * 60 * 1000 + 59 * 1000;
        throw new Error('GitHub release tarball HTTP 403');
      },
      now: () => now,
    });
    expect(started.ok).toBe(true);
    await waitForRemoteUpgradeJob(nodeId);
    now += 2000;
    expect(getRemoteUpgradeJob(nodeId, now)?.state).toBe('failed');
    now += 10 * 60 * 1000;
    expect(getRemoteUpgradeJob(nodeId, now)).toBeNull();
  });

  test('cancel aborts an in-flight push, cancels the file stream, and marks cancelled', async () => {
    const nodeId = 'aa'.repeat(16);
    const path = tempFile(new Uint8Array([1, 2, 3, 4]));
    let pushSignal: AbortSignal | undefined;
    let fileCancelled = false;
    const started = startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          if (input.method === 'PUT') {
            pushSignal = input.signal;
            if (input.rawBody) {
              const orig = input.rawBody.cancel.bind(input.rawBody);
              input.rawBody.cancel = async (reason?: unknown) => {
                fileCancelled = true;
                return orig(reason);
              };
            }
            await new Promise<never>((_, reject) => {
              const fail = (): void => {
                const err = new Error('UPGRADE_CANCELLED');
                err.name = 'AbortError';
                reject(err);
              };
              if (input.signal?.aborted) {
                fail();
                return;
              }
              input.signal?.addEventListener('abort', fail, { once: true });
            });
          }
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: 4 }),
    });
    expect(started.ok).toBe(true);
    for (let i = 0; i < 50 && !pushSignal; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pushSignal).toBeTruthy();
    const cancelled = await cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          return new Response('{}', { status: 200 });
        },
      },
    });
    expect(cancelled.handled).toBe(true);
    if (cancelled.handled !== true) throw new Error('expected handled');
    expect(cancelled.snapshot.state).toBe('cancelled');
    expect(cancelled.snapshot.error).toBe('UPGRADE_CANCELLED');
    expect(pushSignal?.aborted).toBe(true);
    expect(fileCancelled).toBe(true);
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('cancelled');
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('cancelled');
  }, 8_000);

  test('cancel during download removes the cache .part and never leaves a tarball without sidecar', async () => {
    const nodeId = 'bb'.repeat(16);
    const cacheDir = mkdtempSync(join(tmpdir(), 'tmex-job-cancel-dl-'));
    tempDirs.push(cacheDir);
    process.env.TMEX_RELEASE_CACHE_DIR = cacheDir;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('SHA256SUMS')) {
        return new Response(`${'ab'.repeat(32)}  tmex-cli-9.9.9.tgz\n`, { status: 200 });
      }
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          controller.enqueue(new Uint8Array(16 * 1024).fill(2));
          await new Promise<void>((resolve) => {
            if (!signal) {
              resolve();
              return;
            }
            const timer = setTimeout(resolve, 15);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      const started = startRemoteUpgradeJob({
        nodeId,
        version: '9.9.9',
        req: authed(nodeId),
        forward: {
          async forwardAuthorizedHttp() {
            throw new Error('should not push');
          },
        },
      });
      expect(started.ok).toBe(true);
      const part = join(cacheDir, 'tmex-cli-9.9.9.tgz.part');
      for (let i = 0; i < 50 && !existsSync(part); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const cancelled = await cancelRemoteUpgradeJob({
        nodeId,
        req: authed(nodeId),
        forward: {
          async forwardAuthorizedHttp() {
            return new Response('{}', { status: 200 });
          },
        },
      });
      expect(cancelled.handled).toBe(true);
      await waitForRemoteUpgradeJob(nodeId);
      expect(existsSync(part)).toBe(false);
      expect(existsSync(join(cacheDir, 'tmex-cli-9.9.9.tgz'))).toBe(false);
      expect(existsSync(join(cacheDir, 'tmex-cli-9.9.9.tgz.sha256'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 8_000);

  test('cancel after push but before start DELETEs the staged package on the target', async () => {
    const nodeId = 'cc'.repeat(16);
    const path = tempFile(new Uint8Array([9, 9, 9]));
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        calls.push(`${input.method} ${input.path}`);
        if (input.method === 'PUT') {
          return new Response('{}', { status: 200 });
        }
        if (input.method === 'POST') {
          await gate;
          return new Response('{}', { status: 200 });
        }
        if (input.method === 'DELETE') {
          expect(input.path).toBe('/api/system/upgrade/package');
          expect(input.query).toContain('version=9.9.9');
          return new Response('{}', { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    };
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'ee'.repeat(32), bytes: 3 }),
    });
    for (let i = 0; i < 50 && !calls.includes('POST /api/system/upgrade'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelPromise = cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).not.toContain('DELETE /api/system/upgrade/package');
    releaseStart();
    const cancelled = await cancelPromise;
    expect(cancelled.handled).toBe(false);
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('handed-off');
    await waitForRemoteUpgradeJob(nodeId);
  });

  test('cancel of a handed-off job is not handled by the entry job', async () => {
    const nodeId = 'dd'.repeat(16);
    const path = tempFile(new Uint8Array([1]));
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          return new Response('{}', { status: 200 });
        },
      },
      download: async () => ({ path, sha256: 'ff'.repeat(32), bytes: 1 }),
    });
    await waitForRemoteUpgradeJob(nodeId);
    const cancelled = await cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward: {
        async forwardAuthorizedHttp() {
          throw new Error('should not be called by job cancel');
        },
      },
    });
    expect(cancelled.handled).toBe(false);
  });

  test('cancel after PUT landed but before ACK DELETEs the staged package', async () => {
    const nodeId = 'ee'.repeat(16);
    const installDir = mkdtempSync(join(tmpdir(), 'tmex-job-ack-'));
    tempDirs.push(installDir);
    const install: InstallInfo = {
      installedViaCli: true,
      deployment: 'launchd',
      installDir,
      serviceName: 'tmex',
      cliVersion: '1.1.0',
      bunPath: '/usr/bin/bun',
    };
    const target = new UpgradeController({ getInstallInfo: () => install });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const path = tempFile(bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let putLanded = false;
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        if (input.method === 'PUT' && input.path === '/api/system/upgrade/package') {
          const version = new URLSearchParams((input.query ?? '').replace(/^\?/, '')).get(
            'version'
          );
          const digest = new URLSearchParams((input.query ?? '').replace(/^\?/, '')).get('sha256');
          const result = await target.stagePackage(
            version ?? '',
            digest ?? '',
            input.rawBody ?? null
          );
          putLanded = result.ok;
          await new Promise<void>((resolve, reject) => {
            const fail = (): void => {
              const err = new Error('UPGRADE_CANCELLED');
              err.name = 'AbortError';
              reject(err);
            };
            if (input.signal?.aborted) {
              fail();
              return;
            }
            input.signal?.addEventListener('abort', fail, { once: true });
          });
        }
        if (input.method === 'DELETE' && input.path === '/api/system/upgrade/package') {
          const version = new URLSearchParams((input.query ?? '').replace(/^\?/, '')).get(
            'version'
          );
          const removed = await target.removeStagedPackage(version ?? '');
          if (!removed.ok) {
            return new Response(JSON.stringify({ code: 'PACKAGE_NOT_STAGED' }), { status: 404 });
          }
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    };
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256, bytes: bytes.byteLength }),
      upgradeCapabilities: ['staged-package', 'upgrade-cancel'],
    });
    for (let i = 0; i < 50 && !putLanded; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(putLanded).toBe(true);
    const cancelled = await cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward,
    });
    expect(cancelled.handled).toBe(true);
    await waitForRemoteUpgradeJob(nodeId);
    const stagedDir = join(installDir, 'staging', 'staged');
    const leftover = existsSync(stagedDir) ? readdirSync(stagedDir) : [];
    expect(leftover).toEqual([]);
  }, 8_000);

  test('cancel during staged POST does not abort it; 2xx hands off and is not UPGRADE_CANCELLED', async () => {
    const nodeId = 'a1'.repeat(16);
    const path = tempFile(new Uint8Array([9, 9, 9]));
    let startSignal: AbortSignal | undefined;
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        calls.push(`${input.method} ${input.path}`);
        if (input.method === 'PUT') {
          return new Response('{}', { status: 200 });
        }
        if (input.method === 'POST') {
          startSignal = input.signal;
          await gate;
          return new Response(
            JSON.stringify({
              state: 'downloading',
              targetVersion: '9.9.9',
              error: null,
              startedAt: '2026-09-01T00:00:00.000Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        throw new Error(`unexpected ${input.method} ${input.path}`);
      },
    };
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'ee'.repeat(32), bytes: 3 }),
      upgradeCapabilities: ['staged-package', 'upgrade-cancel'],
    });
    for (let i = 0; i < 50 && !calls.includes('POST /api/system/upgrade'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelPromise = cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(startSignal?.aborted).not.toBe(true);
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('running');
    expect(getRemoteUpgradeJob(nodeId)?.error).not.toBe('UPGRADE_CANCELLED');
    releaseStart();
    const cancelled = await cancelPromise;
    expect(cancelled.handled).toBe(false);
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('handed-off');
    expect(getRemoteUpgradeJob(nodeId)?.error).not.toBe('UPGRADE_CANCELLED');
  }, 8_000);

  test('cancel during staged POST that fails cleans up as a cancelled job', async () => {
    const nodeId = 'a2'.repeat(16);
    const path = tempFile(new Uint8Array([9, 9, 9]));
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        calls.push(`${input.method} ${input.path}`);
        if (input.method === 'PUT') {
          return new Response('{}', { status: 200 });
        }
        if (input.method === 'POST') {
          await gate;
          return new Response(JSON.stringify({ error: 'PACKAGE_NOT_STAGED' }), { status: 409 });
        }
        if (input.method === 'DELETE' && input.path === '/api/system/upgrade/package') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      },
    };
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'ee'.repeat(32), bytes: 3 }),
      upgradeCapabilities: ['staged-package', 'upgrade-cancel'],
    });
    for (let i = 0; i < 50 && !calls.includes('POST /api/system/upgrade'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelPromise = cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).not.toContain('DELETE /api/system/upgrade/package');
    releaseStart();
    const cancelled = await cancelPromise;
    expect(cancelled.handled).toBe(true);
    if (cancelled.handled !== true) throw new Error('expected handled');
    expect(cancelled.snapshot.state).toBe('cancelled');
    expect(cancelled.snapshot.error).toBe('UPGRADE_CANCELLED');
    expect(calls).toContain('DELETE /api/system/upgrade/package');
  }, 8_000);

  test('cancelling a remote job does not abort a shared local download', async () => {
    const nodeId = 'b1'.repeat(16);
    const version = '3.3.3';
    const cacheDir = mkdtempSync(join(tmpdir(), 'tmex-job-share-dl-'));
    tempDirs.push(cacheDir);
    process.env.TMEX_RELEASE_CACHE_DIR = cacheDir;
    const tarball = new Uint8Array([4, 5, 6, 7, 8]);
    const hex = createHash('sha256').update(tarball).digest('hex');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('SHA256SUMS')) {
        return new Response(`${hex}  tmex-cli-${version}.tgz\n`, { status: 200 });
      }
      const signal = init?.signal;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(new DOMException('Aborted', 'AbortError'));
            return;
          }
          if (offset >= tarball.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(tarball.subarray(offset, offset + 1));
          offset += 1;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 20);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    try {
      const local = downloadVerifiedRelease(version, { cacheDir });
      const part = join(cacheDir, `tmex-cli-${version}.tgz.part`);
      for (let i = 0; i < 50 && !existsSync(part); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const started = startRemoteUpgradeJob({
        nodeId,
        version,
        req: authed(nodeId),
        forward: {
          async forwardAuthorizedHttp() {
            return new Response('{}', { status: 200 });
          },
        },
      });
      expect(started.ok).toBe(true);
      const cancelled = await cancelRemoteUpgradeJob({
        nodeId,
        req: authed(nodeId),
        forward: {
          async forwardAuthorizedHttp() {
            return new Response('{}', { status: 200 });
          },
        },
      });
      expect(cancelled.handled).toBe(true);
      const result = await local;
      expect(result.sha256).toBe(hex);
      expect(existsSync(join(cacheDir, `tmex-cli-${version}.tgz`))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 8_000);

  test('cancel after push on a 1.1.11 target is unsupported and keeps the job running', async () => {
    const nodeId = 'c1'.repeat(16);
    const path = tempFile(new Uint8Array([1, 2, 3]));
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const forward: AuthorizedUpgradeForward = {
      async forwardAuthorizedHttp(_req, input) {
        calls.push(`${input.method} ${input.path}`);
        if (input.method === 'PUT') {
          return new Response('{}', { status: 200 });
        }
        if (input.method === 'POST') {
          await gate;
          return new Response('{}', { status: 200 });
        }
        return new Response('gone', { status: 404 });
      },
    };
    startRemoteUpgradeJob({
      nodeId,
      version: '9.9.9',
      req: authed(nodeId),
      forward,
      download: async () => ({ path, sha256: 'aa'.repeat(32), bytes: 3 }),
      upgradeCapabilities: ['staged-package'],
    });
    for (let i = 0; i < 50 && !calls.includes('POST /api/system/upgrade'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const cancelled = await cancelRemoteUpgradeJob({
      nodeId,
      req: authed(nodeId),
      forward,
    });
    expect(cancelled).toEqual({ handled: 'unsupported' });
    expect(getRemoteUpgradeJob(nodeId)?.state).toBe('running');
    expect(getRemoteUpgradeJob(nodeId)?.error).not.toBe('UPGRADE_CANCELLED');
    releaseStart();
    const done = await waitForRemoteUpgradeJob(nodeId);
    expect(done.state).toBe('handed-off');
  }, 8_000);
});
