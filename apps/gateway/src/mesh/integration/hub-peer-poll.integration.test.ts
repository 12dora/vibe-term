import { afterEach, describe, expect, test } from 'bun:test';
import { HubRuntime } from '../../hub';
import type { HubKeyLogSource } from '../../hub/types';
import {
  HUB_B_URL,
  bootAbcdTopology,
  dummyServer,
  meshHubsOf,
  waitUntil,
} from './multi-hub-harness';

const stubKeyLog: HubKeyLogSource = {
  async head() {
    return { seq: 0n, hash: new Uint8Array(32) };
  },
  async list() {
    return [];
  },
  async append() {
    return { ok: false, error: 'unused' };
  },
};

describe('hub peer status poll (in-process)', () => {
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

  test('A polls promoted B and fences itself; node.list names B as writer', async () => {
    const topo = await bootAbcdTopology();
    fixtures.push(topo);
    const { a, b, c } = topo;
    if (!a.mesh.hub) throw new Error('missing hub A');

    const bPromoted = new HubRuntime({
      db: b.db,
      userStore: b.userStore,
      keyLogSource: stubKeyLog,
      meshHubs: meshHubsOf(b.db),
      config: {
        publicUrl: HUB_B_URL,
        stun: [],
        nodeId: b.mesh.nodeId,
        hubNodeId: b.mesh.nodeId,
        mode: 'active',
        priority: 100,
        writerEpoch: 2,
        authorizedHubIds: [a.mesh.nodeId],
      },
      authenticate: () => null,
    });
    fixtures.push({ stop: () => bPromoted.stop() });
    expect(bPromoted.mode()).toBe('active');
    expect(bPromoted.writerEpoch()).toBe(2);

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`${HUB_B_URL}/api/hub/status`)) {
        const res = await bPromoted.handleRequest(new Request(url, init), dummyServer);
        if (!res) throw new Error(`unhandled ${url}`);
        return res;
      }
      return origFetch(input as never, init);
    }) as typeof fetch;

    try {
      expect(a.mesh.hub.mode()).toBe('active');
      await a.mesh.hub.pollPeersNow();
      expect(a.mesh.hub.mode()).toBe('standby');
      await waitUntil(() => c.mesh.lastNodeList?.writerHubId === b.mesh.nodeId, 8_000);
      expect(c.mesh.lastNodeList?.writerEpoch).toBe(2);
      expect(meshHubsOf(a.db).get(b.mesh.nodeId)?.mode).toBe('active');
      expect(meshHubsOf(a.db).get(b.mesh.nodeId)?.writerEpoch).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
