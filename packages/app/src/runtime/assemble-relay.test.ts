import './test-relay-env';
import '../lib/test-master-key';
import { describe, expect, test } from 'bun:test';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { assembleTmex, isRelayOnly, meshShutdownNeeded } from './assemble';

const dummyServer = { upgrade: () => false } as unknown as Bun.Server<unknown>;

function gatewayWith(db: GatewayRuntime['db']): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as GatewayRuntime['wsServer'],
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
  } as GatewayRuntime;
}

async function assembleRelay(roles: { hub: boolean; node: boolean; relay: boolean }) {
  const { db, close } = createMigratedAuthDb();
  const assembled = await assembleTmex({
    roles,
    staticRoot: '/tmp/tmex-relay-no-frontend',
    createGatewayRuntime: async () => gatewayWith(db),
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

describe('assembleTmex relay role', () => {
  test('relay alone mounts the relay runtime with no mesh and no frontend', async () => {
    const { assembled, close } = await assembleRelay({ hub: false, node: false, relay: true });
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
    const { assembled, close } = await assembleRelay({ hub: false, node: false, relay: true });
    try {
      const denied = await assembled.fetch(
        new Request('http://127.0.0.1/api/relay/status'),
        dummyServer
      );
      expect(denied?.status).toBe(401);
      const ok = await assembled.fetch(
        new Request('http://127.0.0.1/api/relay/status', {
          headers: { authorization: 'Bearer assemble-test-relay-admin-token' },
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
    const assembled = await assembleTmex({
      roles: { hub: false, node: false, relay: false },
      staticRoot: '/tmp/tmex-relay-no-frontend',
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
    expect(meshShutdownNeeded({ hub: false, node: false, relay: true })).toBe(true);
    expect(isRelayOnly({ hub: false, node: false, relay: true })).toBe(true);
    expect(isRelayOnly({ hub: false, node: true, relay: true })).toBe(false);
    expect(isRelayOnly({ hub: false, node: false, relay: false })).toBe(false);
  });
});
