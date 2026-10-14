import '../lib/test-master-key';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import { RELAY_UPLINK_WS_KIND } from '../../../../apps/gateway/src/relay';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { assembleVibeTerm, isRelayOnly, meshShutdownNeeded } from './assemble';

const dummyServer = { upgrade: () => false } as unknown as Bun.Server<unknown>;

const RELAY_PUBLIC_URL = 'http://127.0.0.1:19993';
const RELAY_ADMIN_TOKEN = 'assemble-test-relay-admin-token';
const savedEnv = {
  publicUrl: process.env.VIBETERM_RELAY_PUBLIC_URL,
  adminToken: process.env.VIBETERM_RELAY_ADMIN_TOKEN,
  turnPort: process.env.VIBETERM_TURN_PORT,
};

beforeAll(() => {
  process.env.VIBETERM_RELAY_PUBLIC_URL = RELAY_PUBLIC_URL;
  process.env.VIBETERM_RELAY_ADMIN_TOKEN = RELAY_ADMIN_TOKEN;
  process.env.VIBETERM_TURN_PORT = 'off';
});

afterAll(() => {
  process.env.VIBETERM_RELAY_PUBLIC_URL = savedEnv.publicUrl;
  process.env.VIBETERM_RELAY_ADMIN_TOKEN = savedEnv.adminToken;
  process.env.VIBETERM_TURN_PORT = savedEnv.turnPort;
});

function gatewayWith(
  db: GatewayRuntime['db'],
  handleRequest: GatewayRuntime['handleRequest'] = () => undefined
): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as GatewayRuntime['wsServer'],
    handleRequest,
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
  } as GatewayRuntime;
}

async function assembleRelay(
  roles: { node: boolean; relay: boolean },
  handleRequest?: GatewayRuntime['handleRequest']
) {
  const { db, close } = createMigratedAuthDb();
  const assembled = await assembleVibeTerm({
    roles,
    staticRoot: '/tmp/vibeterm-relay-no-frontend',
    createGatewayRuntime: async () => gatewayWith(db, handleRequest),
    createMeshRuntime: async () => {
      throw new Error('mesh runtime must not be created for relay-only');
    },
  });
  return {
    assembled,
    async close() {
      await assembled.stop();
      close();
    },
  };
}

describe('assembleVibeTerm relay role', () => {
  test('relay alone mounts the relay runtime with no mesh and no frontend', async () => {
    const { assembled, close } = await assembleRelay({ node: false, relay: true });
    try {
      expect(assembled.relay).not.toBeNull();
      expect(assembled.mesh).toBeNull();
      const health = await assembled.fetch(
        new Request('http://127.0.0.1/api/relay/health'),
        dummyServer
      );
      expect(health?.status).toBe(200);
      const body = (await health?.json()) as { ok: boolean; tenants: number };
      expect(body.ok).toBe(true);
      expect(body.tenants).toBe(0);
      const page = await assembled.fetch(new Request('http://127.0.0.1/'), dummyServer);
      expect(page?.status).toBe(404);
    } finally {
      await close();
    }
  });

  test('relay admin routes require the admin token', async () => {
    const { assembled, close } = await assembleRelay({ node: false, relay: true });
    try {
      const denied = await assembled.fetch(
        new Request('http://127.0.0.1/api/relay/status'),
        dummyServer
      );
      expect(denied?.status).toBe(401);
      const ok = await assembled.fetch(
        new Request('http://127.0.0.1/api/relay/status', {
          headers: { authorization: `Bearer ${RELAY_ADMIN_TOKEN}` },
        }),
        dummyServer
      );
      expect(ok?.status).toBe(200);
    } finally {
      await close();
    }
  });

  test('standalone assembles without a relay runtime', async () => {
    const { db, close } = createMigratedAuthDb();
    const assembled = await assembleVibeTerm({
      roles: { node: false, relay: false },
      staticRoot: '/tmp/vibeterm-relay-no-frontend',
      createGatewayRuntime: async () => gatewayWith(db),
    });
    try {
      expect(assembled.relay).toBeNull();
    } finally {
      await assembled.stop();
      close();
    }
  });

  test('role helpers treat relay as a shutdown-needing role', () => {
    expect(meshShutdownNeeded({ node: false, relay: true })).toBe(true);
    expect(isRelayOnly({ node: false, relay: true })).toBe(true);
    expect(isRelayOnly({ node: true, relay: true })).toBe(false);
    expect(isRelayOnly({ node: false, relay: false })).toBe(false);
  });
});

describe('assembleVibeTerm relay-only gateway app surface', () => {
  const upgrades: unknown[] = [];
  const upgradeServer = {
    upgrade: (_req: Request, opts: unknown) => {
      upgrades.push(opts);
      return true;
    },
    requestIP: () => null,
  } as unknown as Bun.Server<unknown>;

  async function relayWithGatewaySpy() {
    const reached: string[] = [];
    upgrades.length = 0;
    const handle = await assembleRelay({ node: false, relay: true }, (req) => {
      const path = new URL(req.url).pathname;
      reached.push(path);
      return path === '/healthz'
        ? new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
        : new Response('gateway-leak', { status: 200 });
    });
    return { ...handle, reached };
  }

  test('gateway app routes are 404 and never reach the gateway', async () => {
    const { assembled, close, reached } = await relayWithGatewaySpy();
    try {
      const upgradeHeaders = { upgrade: 'websocket', connection: 'Upgrade' };
      const requests: Request[] = [
        new Request('http://127.0.0.1/api/exec/ws', { headers: upgradeHeaders }),
        new Request('http://127.0.0.1/n/self/api/exec/ws', { headers: upgradeHeaders }),
        new Request('http://127.0.0.1/api/exec', { method: 'POST', body: '{}' }),
        new Request('http://127.0.0.1/ws', { headers: upgradeHeaders }),
        new Request('http://127.0.0.1/n/self/ws', { headers: upgradeHeaders }),
        new Request('http://127.0.0.1/api/devices'),
        new Request('http://127.0.0.1/api/auth/mode'),
        new Request('http://127.0.0.1/healthz', { method: 'POST' }),
        new Request('http://127.0.0.1/'),
      ];
      for (const request of requests) {
        const res = await assembled.fetch(request, upgradeServer);
        expect(res?.status).toBe(404);
        expect(((await res?.json()) as { error: { code: string } }).error.code).toBe(
          'RELAY_NO_FRONTEND'
        );
      }
      expect(reached).toEqual([]);
      expect(upgrades).toEqual([]);
    } finally {
      await close();
    }
  });

  test('GET /healthz is still served', async () => {
    const { assembled, close, reached } = await relayWithGatewaySpy();
    try {
      const res = await assembled.fetch(new Request('http://127.0.0.1/healthz'), dummyServer);
      expect(res?.status).toBe(200);
      expect(reached).toEqual(['/healthz']);
    } finally {
      await close();
    }
  });

  test('relay uplink upgrade still works and ends dispatch', async () => {
    const { assembled, close, reached } = await relayWithGatewaySpy();
    try {
      const res = await assembled.fetch(
        new Request('http://127.0.0.1/relay/uplink', {
          headers: { upgrade: 'websocket', connection: 'Upgrade' },
        }),
        upgradeServer
      );
      expect(res).toBeUndefined();
      expect(upgrades).toHaveLength(1);
      expect((upgrades[0] as { data: { kind: string } }).data.kind).toBe(RELAY_UPLINK_WS_KIND);
      expect(reached).toEqual([]);
    } finally {
      await close();
    }
  });

  test('standalone still dispatches /api/* to the gateway', async () => {
    const { db, close } = createMigratedAuthDb();
    const assembled = await assembleVibeTerm({
      roles: { node: false, relay: false },
      localAuthEffective: () => false,
      createGatewayRuntime: async () =>
        gatewayWith(db, (req) =>
          new URL(req.url).pathname === '/api/devices'
            ? new Response('gateway-devices', { status: 200 })
            : undefined
        ),
    });
    try {
      const res = await assembled.fetch(new Request('http://127.0.0.1/api/devices'), dummyServer);
      expect(res?.status).toBe(200);
      expect(await res?.text()).toBe('gateway-devices');
    } finally {
      await assembled.stop();
      close();
    }
  });
});
