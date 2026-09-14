import { afterEach, describe, expect, test } from 'bun:test';
import { UserStore } from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';
import { getMeshAgentBridge } from './mesh-agent-bridge';
import { createMeshRuntime } from './mesh-runtime';
import { seedUser } from './test-support';

function fakeGateway(db: AuthDb): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as WebSocketServer,
    handleRequest: () => undefined,
    dispatchHttp: async () => new Response('not-found', { status: 404 }),
    websocket: {
      backpressureLimit: 1024,
      closeOnBackpressureLimit: true,
      open() {},
      message() {},
      drain() {},
      close() {},
      closeSession() {},
    },
    onRestartRequested() {},
    stop: async () => {},
  };
}

describe('mesh node presence without uplink', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('unattached node has empty uplink-online set and lookupNode is not online', async () => {
    const { db, close } = createMigratedAuthDb();
    const userStore = new UserStore(db);
    seedUser(userStore);
    const peerId = 'cd'.repeat(16);
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { node: true, relay: false },
        peerPort: 0,
        stunServers: [],
      },
      startPeerServer: false,
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    await mesh.start();
    expect(mesh.uplink.candidates()).toEqual([]);
    expect(getMeshAgentBridge()?.lookupNode(peerId) ?? null).not.toBe('online');
  });
});
