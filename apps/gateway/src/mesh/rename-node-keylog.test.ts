import { afterEach, describe, expect, test } from 'bun:test';
import { encodeRenameNodePayload, hexToBytes } from '@tmex/shared/auth';
import { UserStore } from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';
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

describe('rename-node keylog runtime', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('self rename-node emits NODE_EVENT and onLocalNodeName', async () => {
    const { db, close } = createMigratedAuthDb();
    seedUser(new UserStore(db));
    const names: string[] = [];
    const events: Array<{ nodeId: string; name?: string }> = [];
    const mesh = await createMeshRuntime({
      db,
      gateway: fakeGateway(db),
      config: {
        roles: { hub: true, node: true, relay: false },
        hubUrl: null,
        hubPublicUrl: 'http://127.0.0.1',
        peerPort: 0,
        stunServers: [],
      },
      startPeerServer: false,
      onLocalNodeName: (name) => names.push(name),
    });
    fixtures.push({ close, stop: () => mesh.stop() });
    mesh.onNodeEvent((event) => {
      events.push({ nodeId: event.nodeId, name: event.name });
    });
    await mesh.start();
    const boot = await mesh.userKeyService.bootstrapUserWithSelfAdmit({
      username: 'hub',
      password: 'pw',
      identity: mesh.identity,
    });
    const applied = await mesh.userKeyService.signAndApply(boot.userId, boot.rootKey, {
      type: 'rename-node',
      payload: encodeRenameNodePayload({
        node_id: hexToBytes(mesh.nodeId),
        name: 'studio',
      }),
    });
    expect(applied.ok).toBe(true);
    expect(events.some((event) => event.nodeId === mesh.nodeId && event.name === 'studio')).toBe(
      true
    );
    expect(names).toEqual(['studio']);
  });
});
