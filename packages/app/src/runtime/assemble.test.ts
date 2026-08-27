import { afterEach, describe, expect, test } from 'bun:test';
import type { HubRuntime } from '../../../../apps/gateway/src/hub';
import type { MeshRuntime } from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { assembleTmex, installShutdownHandlers } from './assemble';

function fakeGateway(overrides?: Partial<GatewayRuntime>): GatewayRuntime {
  return {
    port: 0,
    db: {} as GatewayRuntime['db'],
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
    ...overrides,
  };
}

function fakeHub(overrides?: Partial<HubRuntime>): HubRuntime {
  return {
    attachLocalNode() {},
    handleRequest: async () => undefined,
    isUplinkSocket: () => false,
    handleUplinkOpen() {},
    handleUplinkMessage() {},
    handleUplinkClose() {},
    handleUplinkDrain() {},
    stop() {},
    ...overrides,
  } as HubRuntime;
}

function fakeMesh(overrides?: Partial<MeshRuntime> & { hub?: HubRuntime | null }): MeshRuntime {
  return {
    nodeId: 'ab'.repeat(16),
    hub: overrides?.hub ?? null,
    handleRequest: async () => null,
    localUiGuard: () => null,
    websocket: {
      open() {},
      message() {},
      drain() {},
      close() {},
    },
    start: async () => {},
    stop: async () => {},
    ...overrides,
  } as MeshRuntime;
}

const dummyServer = {
  upgrade: () => false,
} as unknown as Bun.Server<unknown>;

describe('assembleTmex role matrix', () => {
  const originalRoles = process.env.TMEX_ROLES;

  afterEach(() => {
    if (originalRoles === undefined) {
      process.env.TMEX_ROLES = undefined;
    } else {
      process.env.TMEX_ROLES = originalRoles;
    }
  });

  test('standalone does not construct mesh and /api/auth/mode falls to gateway 404', async () => {
    process.env.TMEX_ROLES = 'standalone';
    let meshBuilt = 0;
    const gateway = fakeGateway({
      handleRequest(req) {
        const path = new URL(req.url).pathname;
        if (path.startsWith('/api/') || path === '/healthz') {
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
        }
        return undefined;
      },
    });
    const assembled = await assembleTmex({
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => {
        meshBuilt += 1;
        throw new Error('standalone must not construct mesh');
      },
      serveFrontend: async () => new Response('spa'),
    });

    expect(meshBuilt).toBe(0);
    expect(assembled.mesh).toBeNull();
    expect(assembled.hub).toBeNull();

    const mode = await assembled.fetch(new Request('http://127.0.0.1/api/auth/mode'), dummyServer);
    expect(mode).toBeInstanceOf(Response);
    expect(mode?.status).toBe(404);

    const login = await assembled.fetch(new Request('http://127.0.0.1/login'), dummyServer);
    expect(await login?.text()).toBe('spa');
  });

  test('node role fetch order is mesh localUiGuard → mesh handleRequest → gateway → spa', async () => {
    const order: string[] = [];
    const gateway = fakeGateway({
      handleRequest() {
        order.push('gateway');
        return undefined;
      },
    });
    const mesh = fakeMesh({
      localUiGuard() {
        order.push('guard');
        return null;
      },
      async handleRequest() {
        order.push('mesh');
        return null;
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
      serveFrontend: async () => {
        order.push('spa');
        return new Response('spa');
      },
    });

    const res = await assembled.fetch(new Request('http://127.0.0.1/api/devices'), dummyServer);
    expect(await res?.text()).toBe('spa');
    expect(order).toEqual(['guard', 'mesh', 'gateway', 'spa']);
  });

  test('hub,node fetch order is hub → mesh guard → mesh → gateway, and start attaches local node', async () => {
    const order: string[] = [];
    let attached = 0;
    const hub = fakeHub({
      async handleRequest() {
        order.push('hub');
        return undefined;
      },
      attachLocalNode() {
        attached += 1;
      },
    });
    const mesh = fakeMesh({
      hub,
      localUiGuard() {
        order.push('guard');
        return null;
      },
      async handleRequest() {
        order.push('mesh');
        return null;
      },
      async start() {
        hub.attachLocalNode({} as never);
      },
    });
    const gateway = fakeGateway({
      handleRequest() {
        order.push('gateway');
        return new Response('gw');
      },
    });
    let seenHub: HubRuntime | undefined;
    const assembled = await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async (opts) => {
        seenHub = opts.hub;
        return mesh;
      },
      serveFrontend: async () => new Response('spa'),
    });

    expect(assembled.hub).toBe(hub);
    await assembled.start();
    expect(attached).toBe(1);

    const res = await assembled.fetch(new Request('http://127.0.0.1/api/devices'), dummyServer);
    expect(await res?.text()).toBe('gw');
    expect(order).toEqual(['hub', 'guard', 'mesh', 'gateway']);
    expect(seenHub === hub || seenHub === undefined).toBe(true);
  });

  test('SPA deep links /login /nodes /n/:id fall through to frontend', async () => {
    const assembled = await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => fakeMesh({ hub: fakeHub() }),
      serveFrontend: async (req) => new Response(`spa:${new URL(req.url).pathname}`),
    });
    for (const path of ['/login', '/nodes', '/n/abcd/devices/1']) {
      const res = await assembled.fetch(new Request(`http://127.0.0.1${path}`), dummyServer);
      expect(await res?.text()).toBe(`spa:${path}`);
    }
  });

  test('websocket dispatches hub-uplink to hub, mesh kinds to mesh, otherwise gateway', async () => {
    const hits: string[] = [];
    const hub = fakeHub({
      isUplinkSocket(ws) {
        return (ws as { data?: { kind?: string } }).data?.kind === 'hub-uplink';
      },
      handleUplinkOpen() {
        hits.push('hub-open');
      },
      handleUplinkMessage() {
        hits.push('hub-message');
      },
      handleUplinkClose() {
        hits.push('hub-close');
      },
      handleUplinkDrain() {
        hits.push('hub-drain');
      },
    });
    const mesh = fakeMesh({
      hub,
      websocket: {
        open() {
          hits.push('mesh-open');
        },
        message() {
          hits.push('mesh-message');
        },
        drain() {
          hits.push('mesh-drain');
        },
        close() {
          hits.push('mesh-close');
        },
      },
    });
    const gateway = fakeGateway({
      websocket: {
        backpressureLimit: 1024,
        closeOnBackpressureLimit: true,
        open() {
          hits.push('gw-open');
        },
        message() {
          hits.push('gw-message');
        },
        drain() {
          hits.push('gw-drain');
        },
        close() {
          hits.push('gw-close');
        },
        closeSession() {},
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });

    const hubWs = { data: { kind: 'hub-uplink' } } as Bun.ServerWebSocket<unknown>;
    assembled.websocket.open(hubWs);
    assembled.websocket.message(hubWs, 'x');
    assembled.websocket.drain(hubWs);
    assembled.websocket.close(hubWs, 1000, 'done');

    const meshWs = { data: { kind: 'mesh-event' } } as Bun.ServerWebSocket<unknown>;
    assembled.websocket.open(meshWs);
    assembled.websocket.message(meshWs, 'x');
    assembled.websocket.drain(meshWs);
    assembled.websocket.close(meshWs, 1000, 'done');

    const gwWs = { data: {} } as Bun.ServerWebSocket<unknown>;
    assembled.websocket.open(gwWs);
    assembled.websocket.message(gwWs, 'x');
    assembled.websocket.drain(gwWs);
    assembled.websocket.close(gwWs, 1000, 'done');

    expect(hits).toEqual([
      'hub-open',
      'hub-message',
      'hub-drain',
      'hub-close',
      'mesh-open',
      'mesh-message',
      'mesh-drain',
      'mesh-close',
      'gw-open',
      'gw-message',
      'gw-drain',
      'gw-close',
    ]);
  });

  test('shutdown order is mesh (peer+uplink) → hub → gateway', async () => {
    const order: string[] = [];
    const hub = fakeHub({
      stop() {
        order.push('hub');
      },
    });
    const mesh = fakeMesh({
      hub,
      async stop() {
        order.push('mesh');
      },
    });
    const gateway = fakeGateway({
      async stop() {
        order.push('gateway');
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    await assembled.stop();
    expect(order).toEqual(['mesh', 'hub', 'gateway']);
  });

  test('fake Bun.serve captures fetch and websocket from the assembly', async () => {
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
    });
    let captured: { fetch?: unknown; websocket?: unknown } | null = null;
    const serve = ((opts: { fetch: unknown; websocket: unknown }) => {
      captured = opts;
      return { port: 0, stop() {} };
    }) as unknown as typeof Bun.serve;
    const server = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: assembled.fetch,
      websocket: assembled.websocket,
    });
    expect(captured?.fetch).toBe(assembled.fetch);
    expect(captured?.websocket).toBe(assembled.websocket);
    server.stop();
  });
});

describe('installShutdownHandlers', () => {
  test('SIGINT runs stop then exits 0', async () => {
    const handlers = new Map<string, () => void>();
    let exited: number | undefined;
    const order: string[] = [];
    installShutdownHandlers(
      async () => {
        order.push('stop');
      },
      {
        on: (event, fn) => {
          handlers.set(event, fn as () => void);
          return process;
        },
        exit: (code) => {
          exited = code;
        },
        timeoutMs: 1_000,
      }
    );
    expect(handlers.has('SIGINT')).toBe(true);
    expect(handlers.has('SIGTERM')).toBe(true);
    handlers.get('SIGINT')?.();
    await Bun.sleep(20);
    expect(order).toEqual(['stop']);
    expect(exited).toBe(0);
  });

  test('exits 1 if stop exceeds timeout', async () => {
    const handlers = new Map<string, () => void>();
    let exited: number | undefined;
    installShutdownHandlers(() => new Promise(() => {}), {
      on: (event, fn) => {
        handlers.set(event, fn as () => void);
        return process;
      },
      exit: (code) => {
        exited = code;
      },
      timeoutMs: 20,
    });
    handlers.get('SIGTERM')?.();
    await Bun.sleep(50);
    expect(exited).toBe(1);
  });
});
