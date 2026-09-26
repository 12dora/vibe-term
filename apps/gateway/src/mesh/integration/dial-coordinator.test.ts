import { afterEach, describe, expect, test } from 'bun:test';
import { UserStore } from '../../auth';
import { createMigratedAuthDb } from '../../auth/test-db';
import type { AuthDb } from '../../auth/types';
import type { GatewayRuntime } from '../../runtime';
import type { WebSocketServer } from '../../ws';
import { createMeshRuntime } from '../mesh-runtime';
import { RelaySecondaryAttach } from '../relay-secondary-attach';
import { seedUser } from '../test-support';

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

describe('integration: 每个 runtime 自己的 uplink 目标', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('多个网关的 uplink 目标互不影响', async () => {
    const a = createMigratedAuthDb();
    const b = createMigratedAuthDb();
    seedUser(new UserStore(a.db));
    seedUser(new UserStore(b.db));
    const meshA = await createMeshRuntime({
      db: a.db,
      gateway: fakeGateway(a.db),
      config: { roles: { node: true, relay: false }, peerPort: 0, stunServers: [] },
    });
    const meshB = await createMeshRuntime({
      db: b.db,
      gateway: fakeGateway(b.db),
      config: { roles: { node: true, relay: false }, peerPort: 0, stunServers: [] },
    });
    fixtures.push({ close: a.close, stop: () => meshA.stop() });
    fixtures.push({ close: b.close, stop: () => meshB.stop() });
    expect(meshA.relayOpener).toBeInstanceOf(RelaySecondaryAttach);
    expect(meshB.relayOpener).toBeInstanceOf(RelaySecondaryAttach);
    expect(meshA.relayOpener).not.toBe(meshB.relayOpener);
    await meshA.start();
    await meshB.start();
    meshA.uplink.armSwitch('https://a.example');
    expect(meshA.uplink.primaryTarget()).toBe('https://a.example');
    expect(meshB.uplink.primaryTarget()).not.toBe('https://a.example');
  });
});
