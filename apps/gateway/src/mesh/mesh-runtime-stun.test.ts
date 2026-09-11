import { afterEach, describe, expect, test } from 'bun:test';
import { BUILTIN_STUN_SERVERS } from '@vibeterm/shared/net';
import { UserStore } from '../auth';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import type { GatewayRuntime } from '../runtime';
import type { WebSocketServer } from '../ws';
import { createMeshRuntime } from './mesh-runtime';
import { resolveMeshRtcConfig } from './rtc/stun-effective';
import { fakeSocketPair, seedUser } from './test-support';

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

describe('mesh-runtime STUN resolution', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('no env + hub sends [] ⇒ builtin list', () => {
    const resolved = resolveMeshRtcConfig(
      { stunServers: [...BUILTIN_STUN_SERVERS], stunSource: 'builtin' },
      { stun: [], turn: null }
    );
    expect(resolved).toMatchObject({ stun: [...BUILTIN_STUN_SERVERS], source: 'builtin' });
  });

  test('hub custom ⇒ hub list', () => {
    const resolved = resolveMeshRtcConfig(
      { stunServers: [...BUILTIN_STUN_SERVERS], stunSource: 'builtin' },
      { stun: ['stun:hub:3478'], turn: null }
    );
    expect(resolved).toMatchObject({ stun: ['stun:hub:3478'], source: 'hub-custom' });
  });

  test('node custom ⇒ node list even if hub custom', () => {
    const resolved = resolveMeshRtcConfig(
      { stunServers: ['stun:node:3478'], stunSource: 'custom' },
      { stun: ['stun:hub:3478'], turn: null }
    );
    expect(resolved).toMatchObject({ stun: ['stun:node:3478'], source: 'node-custom' });
  });

  test('none ⇒ empty', () => {
    const resolved = resolveMeshRtcConfig(
      { stunServers: [], stunSource: 'disabled' },
      { stun: ['stun:hub:3478'], turn: null }
    );
    expect(resolved).toMatchObject({ stun: [], source: 'node-disabled' });
  });

  test('createMeshRuntime iceConfigProvider follows the four-way precedence', async () => {
    const cases: Array<{
      stunServers: string[];
      stunSource: 'builtin' | 'custom' | 'disabled';
      want: string[];
    }> = [
      {
        stunServers: [...BUILTIN_STUN_SERVERS],
        stunSource: 'builtin',
        want: [...BUILTIN_STUN_SERVERS],
      },
      { stunServers: ['stun:node:3478'], stunSource: 'custom', want: ['stun:node:3478'] },
      { stunServers: [], stunSource: 'disabled', want: [] },
    ];
    for (const row of cases) {
      const { db, close } = createMigratedAuthDb();
      seedUser(new UserStore(db));
      const [clientWs] = fakeSocketPair();
      const mesh = await createMeshRuntime({
        db,
        gateway: fakeGateway(db),
        config: {
          roles: { hub: false, node: true, relay: false },
          hubUrl: 'http://127.0.0.1:9',
          peerPort: 0,
          stunServers: row.stunServers,
          stunSource: row.stunSource,
        },
        wsFactory: () => clientWs,
        peerHostname: '127.0.0.1',
        startPeerServer: false,
      });
      fixtures.push({ close, stop: () => mesh.stop() });
      expect(mesh.rtc.currentIceConfig().stun).toEqual(row.want);
    }
  });
});
