import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import { NodeIdentityStore } from '../../../../apps/gateway/src/auth/node-identity-store';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import type { HubRuntime } from '../../../../apps/gateway/src/hub';
import { MESH_GATEWAY_WS_KIND } from '../../../../apps/gateway/src/mesh/mesh-deps';
import type { MeshRuntime } from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { LoadNative } from '../../../../apps/gateway/src/mesh/rtc';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import { createCa, issueLeaf, parseCertificate } from '../tls/cert-authority';
import {
  SHUTDOWN_TIMEOUT_MS,
  assembleTmex,
  createProcessShutdown,
  installShutdownHandlers,
  meshShutdownNeeded,
} from './assemble';

function fakeIdentityDb(): GatewayRuntime['db'] {
  const chain = {
    select() {
      return chain;
    },
    from() {
      return chain;
    },
    where() {
      return chain;
    },
    get() {
      return undefined;
    },
  };
  return chain as GatewayRuntime['db'];
}

function fakeGateway(overrides?: Partial<GatewayRuntime>): GatewayRuntime {
  return {
    port: 0,
    db: fakeIdentityDb(),
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
    guardGatewayWebSocket: () => null,
    rewriteSelf: () => null,
    closeSocketsForUser() {},
    closeSocketsForSid() {},
    touchSocket: () => true,
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

  test('TMEX_DIRECT_ENABLED=false skips native load even when nativeDir is set', async () => {
    const original = process.env.TMEX_DIRECT_ENABLED;
    process.env.TMEX_DIRECT_ENABLED = 'false';
    try {
      let loadNative: LoadNative | undefined;
      await assembleTmex({
        roles: { hub: false, node: true },
        nativeDir: '/tmp/tmex-native-should-not-load',
        createGatewayRuntime: async () => fakeGateway(),
        createMeshRuntime: async (opts) => {
          loadNative = opts.loadNative;
          return fakeMesh();
        },
      });
      expect(loadNative).toBeTypeOf('function');
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '));
      };
      try {
        expect(await loadNative?.()).toBeNull();
      } finally {
        console.warn = originalWarn;
      }
      expect(warnings.some((line) => line.includes('native-datachannel'))).toBe(false);
    } finally {
      if (original === undefined) {
        process.env.TMEX_DIRECT_ENABLED = undefined;
      } else {
        process.env.TMEX_DIRECT_ENABLED = original;
      }
    }
  });

  test('standalone does not install mesh shutdown handlers', () => {
    expect(meshShutdownNeeded({ hub: false, node: false })).toBe(false);
    expect(meshShutdownNeeded({ hub: false, node: true })).toBe(true);
    expect(meshShutdownNeeded({ hub: true, node: true })).toBe(true);
    expect(SHUTDOWN_TIMEOUT_MS).toBe(20_000);
  });

  test('stop is idempotent and shares one promise across concurrent callers', async () => {
    let stops = 0;
    const gateway = fakeGateway({
      async stop() {
        stops += 1;
      },
    });
    const mesh = fakeMesh({
      async stop() {
        stops += 1;
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    const [a, b] = await Promise.all([assembled.stop(), assembled.stop()]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(stops).toBe(2);
    await assembled.stop();
    expect(stops).toBe(2);
  });

  test('stops agent sessions before mesh, then gateway', async () => {
    const order: string[] = [];
    const gateway = fakeGateway({
      async stopAgentSessions() {
        order.push('agent');
      },
      async stop() {
        order.push('gateway');
      },
    });
    const mesh = fakeMesh({
      async stop() {
        order.push('mesh');
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    await assembled.stop();
    expect(order).toEqual(['agent', 'mesh', 'gateway']);
  });

  test('restores remote agent sessions after mesh start', async () => {
    const order: string[] = [];
    const gateway = fakeGateway({
      restoreRemoteAgentSessions() {
        order.push('restore');
      },
    });
    const mesh = fakeMesh({
      async start() {
        order.push('mesh');
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    await assembled.start();
    expect(order).toEqual(['mesh', 'restore']);
  });

  test('registers gateway WS with cid from the upgrade query, not a client connectionId', async () => {
    const registered: Array<{ cid?: string; sid: string; uid: string; via: string }> = [];
    const mesh = fakeMesh({
      registerGatewaySession(entry) {
        registered.push({
          cid: entry.cid,
          sid: entry.sid,
          uid: entry.uid,
          via: entry.via,
        });
        return {
          ok: true as const,
          entry: {
            connectionId: 'server-id',
            sid: entry.sid,
            uid: entry.uid,
            via: entry.via,
            session: entry.session,
            lastVerifyAt: 0,
          },
        };
      },
    });
    const gateway = fakeGateway({
      websocket: {
        backpressureLimit: 1024,
        closeOnBackpressureLimit: true,
        open(ws) {
          (ws.data as { session?: { id: string } }).session = { id: 'generated-id' };
        },
        message() {},
        drain() {},
        close() {},
        closeSession() {},
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    assembled.websocket.open({
      data: {
        kind: MESH_GATEWAY_WS_KIND,
        sid: 'sid-1',
        uid: 'uid-1',
        via: 'self',
        cid: 'tab-nonce',
      },
    } as never);
    assembled.websocket.open({
      data: { kind: MESH_GATEWAY_WS_KIND, sid: 'sid-1', uid: 'uid-1', via: 'self' },
    } as never);
    expect(registered).toEqual([
      { cid: 'tab-nonce', sid: 'sid-1', uid: 'uid-1', via: 'self' },
      { cid: undefined, sid: 'sid-1', uid: 'uid-1', via: 'self' },
    ]);
  });

  test('standalone does not construct mesh and /api/auth/mode returns {mode:none}', async () => {
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
    expect(mode?.status).toBe(200);
    expect(await mode?.json()).toEqual({ mode: 'none' });

    const devices = await assembled.fetch(new Request('http://127.0.0.1/api/devices'), dummyServer);
    expect(devices?.status).toBe(404);

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
      'mesh-close',
      'gw-close',
    ]);
  });

  test('stop continues hub and gateway when mesh.stop throws', async () => {
    const order: string[] = [];
    const hub = fakeHub({
      stop() {
        order.push('hub');
        throw new Error('hub-fail');
      },
    });
    const mesh = fakeMesh({
      hub,
      async stop() {
        order.push('mesh');
        throw new Error('mesh-fail');
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

  test('assembler injects clientIp, rewrites /n/self, and guards /ws', async () => {
    const seen: string[] = [];
    let capturedIp: string | undefined;
    const { getMeshRequestContext } = await import('../../../../apps/gateway/src/mesh/mesh-deps');
    const mesh = fakeMesh({
      localUiGuard(req) {
        capturedIp = getMeshRequestContext(req).clientIp;
        seen.push(`guard:${new URL(req.url).pathname}`);
        return null;
      },
      async handleRequest(req) {
        seen.push(`mesh:${new URL(req.url).pathname}`);
        const path = new URL(req.url).pathname;
        if (path.startsWith('/n/self/')) {
          return { rewritten: new Request('http://127.0.0.1/api/devices') };
        }
        return null;
      },
      guardGatewayWebSocket(req) {
        seen.push(`ws:${new URL(req.url).pathname}`);
        return new Response('blocked-ws', { status: 401 });
      },
    });
    const gateway = fakeGateway({
      handleRequest(req) {
        seen.push(`gateway:${new URL(req.url).pathname}`);
        return new Response('gw');
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    const server = {
      upgrade: () => false,
      requestIP: () => ({ address: '203.0.113.9', family: 'IPv4', port: 443 }),
    } as unknown as Bun.Server<unknown>;

    const rewritten = await assembled.fetch(
      new Request('http://127.0.0.1/n/self/api/devices'),
      server
    );
    expect(await rewritten?.text()).toBe('gw');
    expect(capturedIp).toBe('203.0.113.9');
    expect(seen).toEqual([
      'mesh:/n/self/api/devices',
      'guard:/api/devices',
      'mesh:/api/devices',
      'gateway:/api/devices',
    ]);

    seen.length = 0;
    const ws = await assembled.fetch(new Request('http://127.0.0.1/ws'), server);
    expect(await ws?.text()).toBe('blocked-ws');
    expect(seen).toEqual(['ws:/ws']);
  });

  test('local gateway responses get x-tmex-session-renewed from attached auth', async () => {
    const { setMeshRequestContext, X_TMEX_SESSION_RENEWED } = await import(
      '../../../../apps/gateway/src/mesh/mesh-deps'
    );
    const mesh = fakeMesh({
      localUiGuard(req) {
        setMeshRequestContext(req, {
          via: 'self',
          sid: 'sess',
          uid: 'user-1',
          renewedExpiresAt: Date.now() + 60_000,
        });
        return null;
      },
    });
    const gateway = fakeGateway({
      handleRequest() {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => gateway,
      createMeshRuntime: async () => mesh,
    });
    const res = await assembled.fetch(new Request('http://127.0.0.1/api/devices'), dummyServer);
    expect(res?.headers.get(X_TMEX_SESSION_RENEWED)).toBeTruthy();
  });

  test('passes persisted identity userId to createMeshRuntime', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new NodeIdentityStore(db);
      const ed = crypto.getRandomValues(new Uint8Array(32));
      const x25519 = crypto.getRandomValues(new Uint8Array(32));
      const certSig = crypto.getRandomValues(new Uint8Array(64));
      await store.save({
        nodeId: 'ab'.repeat(16),
        hubUrl: 'https://hub.example',
        edPrivateKey: ed,
        x25519PrivateKey: x25519,
        certificateJson: '{}',
        certSig,
        userId: 'uid-from-join',
      });
      let seen: string | undefined;
      await assembleTmex({
        roles: { hub: false, node: true },
        createGatewayRuntime: async () => fakeGateway({ db }),
        createMeshRuntime: async (opts) => {
          seen = opts.userId;
          return fakeMesh();
        },
      });
      expect(seen).toBe('uid-from-join');
    } finally {
      close();
    }
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

  test('standalone /api/local/status is served before gateway dispatch', async () => {
    process.env.TMEX_ROLES = 'standalone';
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
    });
    const res = await assembled.fetch(
      new Request('http://127.0.0.1/api/local/status'),
      dummyServer
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { role: string; tls: { mode: string } };
    expect(body.role).toBe('standalone');
    expect(body.tls).toEqual({ mode: 'none', listenerRunning: false, tlsPort: 9443 });
  });

  test('standalone GET /api/tls is served through assembled.fetch and returns mode none', async () => {
    process.env.TMEX_ROLES = 'standalone';
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () =>
        fakeGateway({
          handleRequest(req) {
            const path = new URL(req.url).pathname;
            if (path.startsWith('/api/')) {
              return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
            }
            return undefined;
          },
        }),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
    });
    const res = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { mode: string };
    expect(body.mode).toBe('none');
  });

  test('mesh GET /api/tls without a session is 401 UNAUTHORIZED', async () => {
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => fakeMesh(),
    });
    const res = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'login required' },
    });
  });

  test('unknown ACME challenge token is 404, not SPA fallback', async () => {
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
      serveFrontend: async () =>
        new Response('<html>index.html</html>', { headers: { 'content-type': 'text/html' } }),
    });
    const res = await assembled.fetch(
      new Request('http://127.0.0.1/.well-known/acme-challenge/unknown-token'),
      dummyServer
    );
    expect(res?.status).toBe(404);
    expect(await res?.text()).not.toContain('index.html');
  });

  test('startup with stored selfsigned config starts https listener; shutdown stops it', async () => {
    const { db, close } = createMigratedAuthDb();
    const port = 20000 + Math.floor(Math.random() * 10000);
    const ca = await createCa({ name: 'tmex assemble CA' });
    const leaf = await issueLeaf({
      ca,
      sans: ['localhost', '127.0.0.1'],
      days: 398,
    });
    const parsed = parseCertificate(leaf.certPem);
    await new TlsConfigStore(db).upsert({
      mode: 'selfsigned',
      tlsPort: port,
      bindHost: '127.0.0.1',
      sans: ['localhost', '127.0.0.1'],
      caCertPem: ca.certPem,
      caKeyPem: ca.keyPem,
      certPem: `${leaf.certPem.trim()}\n${ca.certPem.trim()}\n`,
      keyPem: leaf.keyPem,
      certNotBefore: parsed.notBefore,
      certNotAfter: parsed.notAfter,
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () =>
        fakeGateway({
          db,
          handleRequest(req) {
            if (new URL(req.url).pathname === '/healthz') {
              return new Response(JSON.stringify({ status: 'ok' }), {
                headers: { 'content-type': 'application/json' },
              });
            }
            return undefined;
          },
        }),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
    });
    try {
      await assembled.start();
      await assembled.tls.startup();
      expect(assembled.httpsListener.state().running).toBe(true);
      expect(assembled.httpsListener.state().port).toBe(port);

      const res = await fetch(`https://127.0.0.1:${port}/healthz`, { tls: { ca: ca.certPem } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });

      assembled.tls.stop();
      await assembled.httpsListener.stop();
      await assembled.stop();
      expect(assembled.httpsListener.state().running).toBe(false);

      let refused = false;
      try {
        await fetch(`https://127.0.0.1:${port}/healthz`, { tls: { ca: ca.certPem } });
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
    } finally {
      assembled.tls?.stop();
      await assembled.httpsListener?.stop();
      await assembled.stop();
      close();
    }
  });

  test('mesh /api/setup/hub is 404 not_standalone before localUiGuard', async () => {
    let guarded = 0;
    const mesh = fakeMesh({
      localUiGuard() {
        guarded += 1;
        return new Response('guarded', { status: 401 });
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => mesh,
    });
    const res = await assembled.fetch(
      new Request('http://127.0.0.1/api/setup/hub', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hubPublicUrl: 'https://hub.example',
          username: 'alice',
          password: 'tmex-test-pass',
          directEnable: false,
        }),
      }),
      dummyServer
    );
    expect(res?.status).toBe(404);
    expect(await res?.json()).toEqual({
      error: { code: 'not_standalone', message: 'setup is only available in standalone mode' },
    });
    expect(guarded).toBe(0);
  });

  test('mesh unauthenticated /healthz includes startedAt', async () => {
    const mesh = fakeMesh({
      async handleRequest() {
        return Response.json({ status: 'ok' });
      },
    });
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => mesh,
    });
    const res = await assembled.fetch(new Request('http://127.0.0.1/healthz'), dummyServer);
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { status: string; startedAt: number };
    expect(body.status).toBe('ok');
    expect(typeof body.startedAt).toBe('number');
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

  test('restart and signals share one shutdown promise and 20s budget', async () => {
    const handlers = new Map<string, () => void>();
    let exits = 0;
    let stops = 0;
    const run = installShutdownHandlers(
      async () => {
        stops += 1;
        await Bun.sleep(20);
      },
      {
        on: (event, fn) => {
          handlers.set(event, fn as () => void);
          return process;
        },
        exit: () => {
          exits += 1;
        },
        timeoutMs: 1_000,
      }
    );
    const restart = run();
    handlers.get('SIGINT')?.();
    await Promise.all([restart, run()]);
    expect(stops).toBe(1);
    expect(exits).toBe(1);
    expect(createProcessShutdown).toBeTypeOf('function');
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
