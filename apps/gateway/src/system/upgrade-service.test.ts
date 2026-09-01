import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { releaseTarballName } from '@tmex/shared';
import type { SystemInfo } from '@tmex/shared';
import type { UserStore } from '../auth/user-store';
import * as infoPublic from './info-public';
import { resetReleaseDownloadForTests } from './release-download';
import { resetRemoteUpgradeJobsForTests, waitForRemoteUpgradeJob } from './remote-upgrade-job';
import { upgradeController } from './upgrade';
import {
  handleMeshNodeUpgradeStart,
  handleMeshNodeUpgradeStatus,
  isAlreadyAtOrAboveLatest,
  mapForwardedUpgradeResponse,
} from './upgrade-service';

const originalFetch = globalThis.fetch;
const originalReleaseCacheDir = process.env.TMEX_RELEASE_CACHE_DIR;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRemoteUpgradeJobsForTests();
  resetReleaseDownloadForTests();
  if (originalReleaseCacheDir === undefined) delete process.env.TMEX_RELEASE_CACHE_DIR;
  else process.env.TMEX_RELEASE_CACHE_DIR = originalReleaseCacheDir;
});

describe('isAlreadyAtOrAboveLatest', () => {
  test('same or newer parsed version is already latest', () => {
    expect(isAlreadyAtOrAboveLatest('1.2.3', '1.2.3')).toBe(true);
    expect(isAlreadyAtOrAboveLatest('1.2.4', '1.2.3')).toBe(true);
  });

  test('older version needs an upgrade', () => {
    expect(isAlreadyAtOrAboveLatest('1.2.2', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('1.1.0', '1.2.0')).toBe(false);
  });

  test('older prerelease is not already latest', () => {
    expect(isAlreadyAtOrAboveLatest('1.2.3-beta.2', '1.2.3-beta.10')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('1.2.3-beta.10', '1.2.3')).toBe(false);
  });

  test('unparseable current versions are not treated as latest', () => {
    expect(isAlreadyAtOrAboveLatest('unknown', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('1.2.3_dev', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest('', '1.2.3')).toBe(false);
    expect(isAlreadyAtOrAboveLatest(null, '1.2.3')).toBe(false);
  });
});

describe('mapForwardedUpgradeResponse', () => {
  const nodeId = 'ab'.repeat(16);

  test('404 → UPGRADE_UNSUPPORTED', async () => {
    const mapped = await mapForwardedUpgradeResponse(nodeId, new Response('gone', { status: 404 }));
    expect(mapped.status).toBe(404);
    expect(await mapped.json()).toEqual({ code: 'UPGRADE_UNSUPPORTED', nodeId });
  });

  test('403 → UPGRADE_NOT_ALLOWED', async () => {
    const mapped = await mapForwardedUpgradeResponse(
      nodeId,
      new Response(JSON.stringify({ error: 'no' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(mapped.status).toBe(403);
    expect(await mapped.json()).toEqual({ code: 'UPGRADE_NOT_ALLOWED', nodeId });
  });

  test('404/403 mapping cancels the unused upstream body', async () => {
    const gone = cancellableResponse(404, 'gone');
    await mapForwardedUpgradeResponse(nodeId, gone.response);
    expect(gone.cancelled.value).toBe(true);

    const forbidden = cancellableResponse(403, '{"error":"no"}');
    await mapForwardedUpgradeResponse(nodeId, forbidden.response);
    expect(forbidden.cancelled.value).toBe(true);
  });

  test('409 → UPGRADE_IN_PROGRESS and keeps target status fields', async () => {
    const mapped = await mapForwardedUpgradeResponse(
      nodeId,
      new Response(
        JSON.stringify({
          state: 'downloading',
          targetVersion: '9.9.9',
          error: 'busy',
          startedAt: '2026-08-30T00:00:00.000Z',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    );
    expect(mapped.status).toBe(409);
    expect(await mapped.json()).toEqual({
      code: 'UPGRADE_IN_PROGRESS',
      nodeId,
      state: 'downloading',
      targetVersion: '9.9.9',
      error: 'busy',
      startedAt: '2026-08-30T00:00:00.000Z',
    });
  });

  test('409 ignores spoofed code/nodeId and non-status fields', async () => {
    const mapped = await mapForwardedUpgradeResponse(
      nodeId,
      new Response(
        JSON.stringify({
          code: 'UPGRADE_ALREADY_LATEST',
          nodeId: 'spoof',
          state: 'executing',
          targetVersion: '9.9.9',
          error: 'busy',
          startedAt: '2026-08-30T00:00:00.000Z',
          extra: 'drop-me',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    );
    expect(mapped.status).toBe(409);
    expect(await mapped.json()).toEqual({
      code: 'UPGRADE_IN_PROGRESS',
      nodeId,
      state: 'executing',
      targetVersion: '9.9.9',
      error: 'busy',
      startedAt: '2026-08-30T00:00:00.000Z',
    });
  });

  test('409 with an oversized body still maps to UPGRADE_IN_PROGRESS without extra fields', async () => {
    const mapped = await mapForwardedUpgradeResponse(
      nodeId,
      new Response(JSON.stringify({ state: 'executing', pad: 'x'.repeat(70 * 1024) }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(mapped.status).toBe(409);
    expect(await mapped.json()).toEqual({ code: 'UPGRADE_IN_PROGRESS', nodeId });
  });

  test('200 JSON status is passed through', async () => {
    const body = {
      state: 'downloading',
      targetVersion: '9.9.9',
      error: null,
      startedAt: '2026-08-30T00:00:00.000Z',
    };
    const upstream = new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const mapped = await mapForwardedUpgradeResponse(nodeId, upstream);
    expect(mapped.status).toBe(200);
    expect(await mapped.json()).toEqual(body);
  });
});

describe('handleMeshNodeUpgradeStart local preflight', () => {
  const localNodeId = 'ab'.repeat(16);

  test('canSelfUpdate=false beats GitHub 502', async () => {
    const githubHits = mockGithubFailure();
    const res = await handleMeshNodeUpgradeStart({
      req: new Request('http://localhost/upgrade', { method: 'POST' }),
      nodeId: localNodeId,
      localNodeId,
      userStore: stubUserStore(),
      forward: neverForward(),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'UPGRADE_NOT_ALLOWED', nodeId: localNodeId });
    expect(githubHits()).toBe(0);
  });

  test('busy controller beats GitHub 502 and does not call start()', async () => {
    const githubHits = mockGithubFailure();
    const infoSpy = spyOn(infoPublic, 'getSystemInfo').mockReturnValue(
      selfUpdateInfo({ canSelfUpdate: true, baseVersion: '1.0.0' })
    );
    const statusSpy = spyOn(upgradeController, 'status').mockReturnValue({
      state: 'downloading',
      targetVersion: '9.9.9',
      error: null,
      startedAt: '2026-08-30T00:00:00.000Z',
    });
    const startSpy = spyOn(upgradeController, 'start').mockImplementation(() => {
      throw new Error('start() must stay atomic and not run during preflight reject');
    });
    try {
      const res = await handleMeshNodeUpgradeStart({
        req: new Request('http://localhost/upgrade', { method: 'POST' }),
        nodeId: localNodeId,
        localNodeId,
        userStore: stubUserStore(),
        forward: neverForward(),
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: 'UPGRADE_IN_PROGRESS',
        nodeId: localNodeId,
        state: 'downloading',
        targetVersion: '9.9.9',
        error: null,
        startedAt: '2026-08-30T00:00:00.000Z',
      });
      expect(githubHits()).toBe(0);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      statusSpy.mockRestore();
      startSpy.mockRestore();
    }
  });
});

describe('handleMeshNodeUpgradeStart remote info fail-closed', () => {
  const localNodeId = 'cd'.repeat(16);
  const nodeId = 'ab'.repeat(16);

  test('info 200 with unparsable body → NODE_UNREACHABLE and no POST', async () => {
    mockGithubLatest('9.9.9');
    const calls: string[] = [];
    const res = await handleMeshNodeUpgradeStart({
      req: authedRequest(nodeId),
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push(`${input.method} ${input.path}`);
          if (input.path === '/api/system/info') {
            return new Response('{', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          throw new Error(`unexpected forward ${input.method} ${input.path}`);
        },
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'NODE_UNREACHABLE', nodeId });
    expect(calls).toEqual(['GET /api/system/info']);
  });

  test('info 200 with a non-object body → NODE_UNREACHABLE and no POST', async () => {
    mockGithubLatest('9.9.9');
    const calls: string[] = [];
    const res = await handleMeshNodeUpgradeStart({
      req: authedRequest(nodeId),
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push(`${input.method} ${input.path}`);
          return new Response('[]', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'NODE_UNREACHABLE', nodeId });
    expect(calls).toEqual(['GET /api/system/info']);
  });

  test('info 200 with an oversized body → NODE_UNREACHABLE and no POST', async () => {
    mockGithubLatest('9.9.9');
    const calls: string[] = [];
    const res = await handleMeshNodeUpgradeStart({
      req: authedRequest(nodeId),
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push(`${input.method} ${input.path}`);
          return new Response(
            JSON.stringify({ baseVersion: '1.0.0', pad: 'x'.repeat(70 * 1024) }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        },
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'NODE_UNREACHABLE', nodeId });
    expect(calls).toEqual(['GET /api/system/info']);
  });
});

describe('handleMeshNodeUpgradeStart staged-package job', () => {
  const localNodeId = 'cd'.repeat(16);
  const nodeId = 'ab'.repeat(16);

  test('capability present returns downloading immediately and does not POST release', async () => {
    mockGithubLatest('9.9.9');
    const calls: string[] = [];
    const res = await handleMeshNodeUpgradeStart({
      req: authedRequest(nodeId),
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push(`${input.method} ${input.path}`);
          if (input.path === '/api/system/info') {
            return new Response(
              JSON.stringify({
                baseVersion: '1.0.0',
                canSelfUpdate: true,
                upgradeCapabilities: ['staged-package'],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify({ code: 'not-reached' }), { status: 500 });
        },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; targetVersion: string; error: null };
    expect(body.state).toBe('downloading');
    expect(body.targetVersion).toBe('9.9.9');
    expect(body.error).toBeNull();
    expect(calls).toEqual(['GET /api/system/info']);
  });

  test('second start is 409 UPGRADE_IN_PROGRESS even when GitHub is down', async () => {
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    mockGithubLatest('9.9.9');
    const latestFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com')) return latestFetch(input, init);
      await gate;
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const req = authedRequest(nodeId);
    const forward = {
      async forwardAuthorizedHttp(_req: Request, input: { method: string; path: string }) {
        if (input.path === '/api/system/info') {
          return new Response(
            JSON.stringify({
              baseVersion: '1.0.0',
              canSelfUpdate: true,
              upgradeCapabilities: ['staged-package'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200 });
      },
    };
    const first = await handleMeshNodeUpgradeStart({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    expect(first.status).toBe(200);
    globalThis.fetch = (async (_input: RequestInfo | URL) =>
      new Response('unavailable', { status: 502 })) as typeof fetch;
    const second = await handleMeshNodeUpgradeStart({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward: neverForward(),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'UPGRADE_IN_PROGRESS', nodeId });
    releaseDownload();
    await waitForRemoteUpgradeJob(nodeId).catch(() => {});
  });

  test('legacy target without the capability still POSTs {version} and waits', async () => {
    mockGithubLatest('9.9.9');
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const res = await handleMeshNodeUpgradeStart({
      req: authedRequest(nodeId),
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward: {
        async forwardAuthorizedHttp(_req, input) {
          calls.push({ method: input.method, path: input.path, body: input.body });
          if (input.path === '/api/system/info') {
            return new Response(JSON.stringify({ baseVersion: '1.0.0', canSelfUpdate: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(
            JSON.stringify({
              state: 'downloading',
              targetVersion: '9.9.9',
              error: null,
              startedAt: '2026-08-30T00:00:00.000Z',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        },
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/system/info', body: undefined },
      { method: 'POST', path: '/api/system/upgrade', body: { version: '9.9.9' } },
    ]);
  });
});

describe('handleMeshNodeUpgradeStatus job overlay', () => {
  const localNodeId = 'cd'.repeat(16);
  const nodeId = 'ab'.repeat(16);

  test('running job is reported as downloading without forwarding', async () => {
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    mockGithubLatest('9.9.9');
    const latestFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com')) return latestFetch(input, init);
      await gate;
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const forwarded: string[] = [];
    const req = authedRequest(nodeId);
    const forward = {
      async forwardAuthorizedHttp(_req: Request, input: { method: string; path: string }) {
        forwarded.push(`${input.method} ${input.path}`);
        if (input.path === '/api/system/info') {
          return new Response(
            JSON.stringify({
              baseVersion: '1.0.0',
              canSelfUpdate: true,
              upgradeCapabilities: ['staged-package'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200 });
      },
    };
    await handleMeshNodeUpgradeStart({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    const status = await handleMeshNodeUpgradeStatus({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as { state: string; targetVersion: string; error: null };
    expect(body.state).toBe('downloading');
    expect(body.targetVersion).toBe('9.9.9');
    expect(forwarded.filter((c) => c === 'GET /api/system/upgrade')).toEqual([]);
    releaseDownload();
    await waitForRemoteUpgradeJob(nodeId).catch(() => {});
  });

  test('failed job is reported as idle with the step error and does not forward', async () => {
    mockGithubLatest('8.8.8');
    const latestFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('api.github.com')) return latestFetch(input, init);
      return new Response('nope', { status: 403 });
    }) as typeof fetch;
    const forwarded: string[] = [];
    const req = authedRequest(nodeId);
    const forward = {
      async forwardAuthorizedHttp(_req: Request, input: { method: string; path: string }) {
        forwarded.push(`${input.method} ${input.path}`);
        if (input.path === '/api/system/info') {
          return new Response(
            JSON.stringify({
              baseVersion: '1.0.0',
              canSelfUpdate: true,
              upgradeCapabilities: ['staged-package'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('{}', { status: 200 });
      },
    };
    await handleMeshNodeUpgradeStart({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    await waitForRemoteUpgradeJob(nodeId);
    const status = await handleMeshNodeUpgradeStatus({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    expect(status.status).toBe(200);
    const body = (await status.json()) as {
      state: string;
      targetVersion: null;
      error: string;
    };
    expect(body.state).toBe('idle');
    expect(body.targetVersion).toBeNull();
    expect(body.error).toMatch(/download failed/i);
    expect(forwarded.filter((c) => c === 'GET /api/system/upgrade')).toEqual([]);
  });

  test('handed-off job is dropped and status is forwarded', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.TMEX_RELEASE_CACHE_DIR = mkdtempSync(join(tmpdir(), 'tmex-svc-rel-cache-'));
    mockGithubLatest('9.9.9');
    const req = authedRequest(nodeId);
    const forward = {
      async forwardAuthorizedHttp(
        _req: Request,
        input: { method: string; path: string; body?: unknown }
      ) {
        if (input.path === '/api/system/info') {
          return new Response(
            JSON.stringify({
              baseVersion: '1.0.0',
              canSelfUpdate: true,
              upgradeCapabilities: ['staged-package'],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (input.path === '/api/system/upgrade/package' || input.method === 'PUT') {
          return new Response('{}', { status: 200 });
        }
        if (input.method === 'POST' && input.path === '/api/system/upgrade') {
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
        return new Response(
          JSON.stringify({
            state: 'executing',
            targetVersion: '9.9.9',
            error: null,
            startedAt: '2026-09-01T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    };
    // The job will try to download from GitHub; stub tarball + sums so it can finish.
    const payload = new Uint8Array([1, 2, 3]);
    const { createHash } = await import('node:crypto');
    const hex = createHash('sha256').update(payload).digest('hex');
    const latestFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('SHA256SUMS')) {
        return new Response(`${hex}  tmex-cli-9.9.9.tgz\n`, { status: 200 });
      }
      if (url.includes('tmex-cli-')) {
        return new Response(payload, { status: 200 });
      }
      return latestFetch(input);
    }) as typeof fetch;

    await handleMeshNodeUpgradeStart({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    await waitForRemoteUpgradeJob(nodeId);
    const status = await handleMeshNodeUpgradeStatus({
      req,
      nodeId,
      localNodeId,
      userStore: enrolledStore(nodeId),
      forward,
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      state: 'executing',
      targetVersion: '9.9.9',
      error: null,
      startedAt: '2026-09-01T00:00:00.000Z',
    });
  });
});

function stubUserStore(): UserStore {
  return { listCerts: () => [] } as unknown as UserStore;
}

function enrolledStore(nodeId: string): UserStore {
  return {
    listCerts: () => [{ nodeId, revokedLogSeq: null }],
  } as unknown as UserStore;
}

function neverForward(): {
  forwardAuthorizedHttp: () => Promise<Response>;
} {
  return {
    async forwardAuthorizedHttp() {
      throw new Error('remote forward should not run on the local path');
    },
  };
}

function authedRequest(nodeId: string): Request {
  return new Request('http://localhost/upgrade', {
    method: 'POST',
    headers: { cookie: `tmex_s_${nodeId}=remote-sid` },
  });
}

function selfUpdateInfo(overrides: Partial<SystemInfo>): SystemInfo {
  return {
    version: '1.0.0',
    baseVersion: '1.0.0',
    isProd: true,
    installedViaCli: true,
    deployment: 'launchd',
    canSelfUpdate: true,
    serviceName: 'tmex',
    transferMaxBytes: 1,
    ...overrides,
  };
}

function mockGithubFailure(): () => number {
  let hits = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    hits += 1;
    return new Response('unavailable', { status: 502 });
  }) as typeof fetch;
  return () => hits;
}

function mockGithubLatest(version: string): void {
  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    new Response(
      JSON.stringify({
        tag_name: `v${version}`,
        published_at: '2026-08-30T00:00:00.000Z',
        body: 'notes',
        assets: [{ name: releaseTarballName(version) }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;
}

function cancellableResponse(
  status: number,
  payload: string
): { response: Response; cancelled: { value: boolean } } {
  const cancelled = { value: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
    },
    cancel() {
      cancelled.value = true;
    },
  });
  return { response: new Response(body, { status }), cancelled };
}
