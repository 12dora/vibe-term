import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { releaseTarballName } from '@tmex/shared';
import type { SystemInfo } from '@tmex/shared';
import type { UserStore } from '../auth/user-store';
import * as infoPublic from './info-public';
import { upgradeController } from './upgrade';
import {
  handleMeshNodeUpgradeStart,
  isAlreadyAtOrAboveLatest,
  mapForwardedUpgradeResponse,
} from './upgrade-service';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
