import { describe, expect, test } from 'bun:test';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserStore } from '../auth/user-store';
import type { RtcFingerprintProvider } from './mesh-deps';
import { setMeshRequestContext } from './mesh-deps';
import { MeshRoutes, type MeshRoutesDeps } from './mesh-routes';
import { PeerHandshakeError } from './types';

function routes(
  authorizeBrowser: (
    input: Parameters<RtcFingerprintProvider['authorizeBrowser']>[0],
    opts?: { signal?: AbortSignal }
  ) => ReturnType<RtcFingerprintProvider['authorizeBrowser']>
) {
  const deps = {
    roles: { node: true, relay: false },
    nodeId: 'ab'.repeat(16),
    nodePk: new Uint8Array(32),
    userStore: {} as UserStore,
    nodeSessionStore: {} as NodeSessionStore,
    peers: { onNodeEvent: () => () => {} },
    connectionLookup: () => ({ ok: true, connectionId: 'conn-1' }),
    rtcFingerprint: {
      authorizeBrowser: authorizeBrowser as RtcFingerprintProvider['authorizeBrowser'],
    },
  } as unknown as MeshRoutesDeps;
  return new MeshRoutes(deps);
}

function authorizeRequest(signal?: AbortSignal): Request {
  const req = new Request('http://localhost/api/rtc/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rtcSession: 's1',
      fp_browser: { algorithm: 'sha-256', value: 'AA' },
      connectionId: 'conn-1',
    }),
    signal,
  });
  setMeshRequestContext(req, { via: 'entry-1', auth: 'sid-1', uid: 'user-1' });
  return req;
}

describe('POST /api/rtc/authorize failures', () => {
  test('fingerprint timeout is DIRECT_UNAVAILABLE with reason, not an unlogged 500', async () => {
    const res = await routes(() => {
      throw new PeerHandshakeError('timeout', 'local DTLS fingerprint unavailable');
    }).handle(authorizeRequest(), { upgrade: () => true });
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ code: 'DIRECT_UNAVAILABLE', reason: 'timeout' });
  });

  test('abort and unknown failures stay explicit', async () => {
    const aborted = await routes(() => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }).handle(authorizeRequest(), { upgrade: () => true });
    expect(aborted?.status).toBe(503);
    expect(await aborted?.json()).toEqual({ code: 'DIRECT_UNAVAILABLE', reason: 'aborted' });

    const failed = await routes(() => {
      throw new Error('boom');
    }).handle(authorizeRequest(), { upgrade: () => true });
    expect(await failed?.json()).toEqual({ code: 'DIRECT_UNAVAILABLE', reason: 'failed' });
  });

  test('forwards the request abort signal into authorize', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const res = await routes((_input, opts) => {
      seen = opts?.signal;
      return { nonce: new Uint8Array(32).fill(3), fpNode: { algorithm: 'sha-256', value: 'BB' } };
    }).handle(authorizeRequest(controller.signal), { upgrade: () => true });
    expect(res?.status).toBe(200);
    expect(seen).toBe(controller.signal);
  });
});

describe('POST /api/rtc/authorize provider binding', () => {
  test('calls a prototype-method provider with its own this', async () => {
    class Provider {
      readonly fpNode = { algorithm: 'sha-256', value: 'BB' };
      async authorizeBrowser() {
        return { nonce: new Uint8Array([1, 2, 3]), fpNode: this.fpNode };
      }
    }
    const deps = {
      roles: { node: true, relay: false },
      nodeId: 'ab'.repeat(16),
      nodePk: new Uint8Array(32),
      userStore: {} as UserStore,
      nodeSessionStore: {} as NodeSessionStore,
      peers: { onNodeEvent: () => () => {} },
      connectionLookup: () => ({ ok: true, connectionId: 'conn-1' }),
      rtcFingerprint: new Provider() as unknown as RtcFingerprintProvider,
    } as unknown as MeshRoutesDeps;
    const res = await new MeshRoutes(deps).handle(authorizeRequest(), { upgrade: () => true });
    expect(res?.status).toBe(200);
    expect((await res?.json()).fp_node).toEqual({ algorithm: 'sha-256', value: 'BB' });
  });
});
