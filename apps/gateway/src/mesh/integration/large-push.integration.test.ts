import { afterEach, describe, expect, test } from 'bun:test';
import {
  COUNT_BYTES_PATH,
  LARGE_PUSH_BYTES,
  adoptWsSecure,
  bootHubAndLeaf,
  loginEntryToLeaf,
  makeForwarder,
  repeatingBody,
} from './large-push-harness';
import { waitUntil } from './multi-hub-harness';

describe('large raw-body push over mesh', () => {
  const fixtures: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      try {
        await item?.stop();
      } catch {
        /* ignore */
      }
    }
  });

  test('24 MiB rawBody reaches the target over the hub relay path', async () => {
    const pair = await bootHubAndLeaf();
    fixtures.push(pair);
    const cookie = await loginEntryToLeaf(pair);
    const forwarder = makeForwarder(pair.a.mesh);
    const started = Date.now();
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://entry/api/mesh/nodes/x/upgrade', {
        method: 'PUT',
        headers: { cookie, origin: 'http://entry' },
      }),
      {
        nodeId: pair.c.mesh.nodeId,
        method: 'PUT',
        path: COUNT_BYTES_PATH,
        rawBody: repeatingBody(LARGE_PUSH_BYTES),
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(LARGE_PUSH_BYTES),
        },
      }
    );
    const durationMs = Date.now() - started;
    const body = await res.json();
    expect(pair.a.mesh.peers.transportOf(pair.c.mesh.nodeId)).toBe('relay');
    expect(res.status).toBe(200);
    expect(body).toEqual({ received: LARGE_PUSH_BYTES });
    expect(pair.counter.received).toBe(LARGE_PUSH_BYTES);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    console.info(`[large-push] path=relay bytes=${LARGE_PUSH_BYTES} durationMs=${durationMs}`);
  }, 60_000);

  test('24 MiB rawBody reaches the target over a ws-secure direct peer path', async () => {
    const pair = await bootHubAndLeaf();
    fixtures.push(pair);
    const cookie = await loginEntryToLeaf(pair);
    adoptWsSecure(pair);
    await waitUntil(() => pair.a.mesh.peers.transportOf(pair.c.mesh.nodeId) === 'ws-secure', 5_000);
    const forwarder = makeForwarder(pair.a.mesh);
    const started = Date.now();
    const res = await forwarder.forwardAuthorizedHttp(
      new Request('http://entry/api/mesh/nodes/x/upgrade', {
        method: 'PUT',
        headers: { cookie, origin: 'http://entry' },
      }),
      {
        nodeId: pair.c.mesh.nodeId,
        method: 'PUT',
        path: COUNT_BYTES_PATH,
        rawBody: repeatingBody(LARGE_PUSH_BYTES, 0x3c),
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(LARGE_PUSH_BYTES),
        },
      }
    );
    const durationMs = Date.now() - started;
    const body = await res.json();
    expect(pair.a.mesh.peers.transportOf(pair.c.mesh.nodeId)).toBe('ws-secure');
    expect(res.status).toBe(200);
    expect(body).toEqual({ received: LARGE_PUSH_BYTES });
    expect(pair.counter.received).toBe(LARGE_PUSH_BYTES);
    expect(durationMs).toBeGreaterThanOrEqual(0);
    console.info(`[large-push] path=ws-secure bytes=${LARGE_PUSH_BYTES} durationMs=${durationMs}`);
  }, 60_000);
});
