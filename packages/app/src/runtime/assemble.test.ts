import '../lib/test-master-key';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  resetDomainAccessForTests,
  setDomainAccessGuardForTests,
} from '../../../../apps/gateway/src/api/domain-access-routes';
import { NodeIdentityStore } from '../../../../apps/gateway/src/auth/node-identity-store';
import { createMigratedAuthDb } from '../../../../apps/gateway/src/auth/test-db';
import type { HubRuntime } from '../../../../apps/gateway/src/hub';
import {
  MESH_GATEWAY_WS_KIND,
  MESH_REJECT_4401_KIND,
  setMeshRequestContext,
} from '../../../../apps/gateway/src/mesh/mesh-deps';
import type { MeshRuntime } from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { LoadNative } from '../../../../apps/gateway/src/mesh/rtc';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { TlsConfigStore } from '../../../../apps/gateway/src/tls/tls-config-store';
import {
  resetAccessGuardForTests,
  setAccessGuardFetch,
  setAccessGuardSnapshot,
} from '../../../../apps/gateway/src/tunnel/access-guard';
import {
  generateAccessTestKey,
  signAccessJwt,
} from '../../../../apps/gateway/src/tunnel/access-jwt';
import {
  buildLogin,
  createDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeDelegation,
  encodeLogin,
  generateEd25519KeyPair,
  signLogin,
} from '../../../shared/src/auth';
import { deriveRootKey } from '../lib/password';
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
    attachedHub: () => null,
    userStore: { getHubMeta: () => null },
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
    invalidateAuthModeCache() {},
    refreshTlsAndAdvertise: async () => {},
    ...overrides,
  } as MeshRuntime;
}

const dummyServer = {
  upgrade: () => false,
} as unknown as Bun.Server<unknown>;

function serverWithClientIp(address: string | null): Bun.Server<unknown> {
  return {
    upgrade: () => false,
    requestIP: () =>
      address == null
        ? null
        : { address, family: address.includes(':') ? 'IPv6' : 'IPv4', port: 443 },
  } as unknown as Bun.Server<unknown>;
}

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

  test('calls refreshTlsAndAdvertise after the TLS service is assigned to tlsSlot', async () => {
    const fingerprints: Array<string | null> = [];
    let refresh = 0;
    const mesh = fakeMesh({
      async refreshTlsAndAdvertise() {
        refresh += 1;
      },
    });
    await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async (opts) => {
        const tls = await opts.tlsInfo?.();
        fingerprints.push(tls?.caFingerprint ?? null);
        return mesh;
      },
    });
    expect(fingerprints[0]).toBeNull();
    expect(refresh).toBeGreaterThanOrEqual(1);
  });

  test('tlsInfo withholds CA fingerprint while the HTTPS listener is not running', async () => {
    let tlsInfo:
      | (() => Promise<{ caFingerprint: string | null; caPem: string | null }>)
      | undefined;
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async (opts) => {
        tlsInfo = opts.tlsInfo;
        return fakeMesh();
      },
    });
    const afterAssign = await tlsInfo?.();
    expect(afterAssign?.caFingerprint).toBeNull();
    expect((await assembled.tls.status()).listener.running).toBe(false);
    await assembled.stop();
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
    const { db, close } = createMigratedAuthDb();
    let meshBuilt = 0;
    try {
      const gateway = fakeGateway({
        db,
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

      const mode = await assembled.fetch(
        new Request('http://127.0.0.1/api/auth/mode'),
        dummyServer
      );
      expect(mode).toBeInstanceOf(Response);
      expect(mode?.status).toBe(200);
      const modeBody = (await mode?.json()) as {
        mode: string;
        uid: string | null;
        localAuth?: {
          supported: boolean;
          enabled: boolean;
          effective: boolean;
          credentialsPresent: boolean;
        };
      };
      expect(modeBody.mode).toBe('none');
      expect(modeBody.uid).toBeNull();
      expect(modeBody.localAuth).toEqual({
        supported: true,
        enabled: false,
        effective: false,
        credentialsPresent: false,
      });

      const devices = await assembled.fetch(
        new Request('http://127.0.0.1/api/devices'),
        dummyServer
      );
      expect(devices?.status).toBe(404);

      const login = await assembled.fetch(new Request('http://127.0.0.1/login'), dummyServer);
      expect(await login?.text()).toBe('spa');
    } finally {
      close();
    }
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

  test('standalone localAuth 生效时 GET /api/tls 与 node 一样要求会话', async () => {
    process.env.TMEX_ROLES = 'standalone';
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      localAuthEffective: () => true,
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
    });
    const res = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'login required' },
    });
  });

  test('standalone localAuth 未生效时 GET /api/tls 仍开放；开关 live 读', async () => {
    process.env.TMEX_ROLES = 'standalone';
    let effective = false;
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      localAuthEffective: () => effective,
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => {
        throw new Error('no mesh');
      },
    });
    const open = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(open?.status).toBe(200);
    effective = true;
    const closed = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(closed?.status).toBe(401);
    effective = false;
    const restored = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(restored?.status).toBe(200);
  });

  test('node GET /api/tls 不因 localAuthEffective=false 而放行', async () => {
    const assembled = await assembleTmex({
      roles: { hub: false, node: true },
      localAuthEffective: () => false,
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => fakeMesh(),
    });
    const res = await assembled.fetch(new Request('http://127.0.0.1/api/tls'), dummyServer);
    expect(res?.status).toBe(401);
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

  test('standalone localAuth 生效时 /api/local/status 与 /api/devices 要求会话', async () => {
    process.env.TMEX_ROLES = 'standalone';
    const { db, close } = createMigratedAuthDb();
    try {
      const assembled = await assembleTmex({
        roles: { hub: false, node: false },
        localAuthEffective: () => true,
        createGatewayRuntime: async () =>
          fakeGateway({
            db,
            handleRequest(req) {
              const path = new URL(req.url).pathname;
              if (path.startsWith('/api/') || path === '/healthz') {
                return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
              }
              return undefined;
            },
          }),
        createMeshRuntime: async () => {
          throw new Error('no mesh');
        },
        serveFrontend: async () => new Response('spa'),
      });
      const status = await assembled.fetch(
        new Request('http://127.0.0.1/api/local/status'),
        dummyServer
      );
      expect(status?.status).toBe(401);
      const devices = await assembled.fetch(
        new Request('http://127.0.0.1/api/devices'),
        dummyServer
      );
      expect(devices?.status).toBe(401);
      const login = await assembled.fetch(new Request('http://127.0.0.1/login'), dummyServer);
      expect(await login?.text()).toBe('spa');
    } finally {
      close();
    }
  });
});

describe('assembleTmex standalone auth surface', () => {
  const originalRoles = process.env.TMEX_ROLES;
  afterEach(() => {
    if (originalRoles === undefined) process.env.TMEX_ROLES = undefined;
    else process.env.TMEX_ROLES = originalRoles;
  });

  async function assembleStandalone(db: GatewayRuntime['db']) {
    process.env.TMEX_ROLES = 'standalone';
    return assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () =>
        fakeGateway({
          db,
          handleRequest(req) {
            const path = new URL(req.url).pathname;
            if (path.startsWith('/api/') || path === '/healthz') {
              return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
            }
            return undefined;
          },
        }),
      createMeshRuntime: async () => {
        throw new Error('standalone must not construct mesh');
      },
      serveFrontend: async () => new Response('spa'),
    });
  }

  async function json(assembled: Awaited<ReturnType<typeof assembleTmex>>, req: Request) {
    const res = await assembled.fetch(req, dummyServer);
    if (!res) throw new Error(`no response for ${req.url}`);
    return { res, body: (await res.json()) as Record<string, unknown> };
  }

  async function loginWithPassword(
    assembled: Awaited<ReturnType<typeof assembleTmex>>,
    uid: string,
    password: string,
    kdf: { salt: string; memory_kib: number; iterations: number; parallelism: number },
    nodeId: string
  ): Promise<string> {
    const rootKey = await deriveRootKey(password, {
      salt: decodeBase64url(kdf.salt),
      memory_kib: kdf.memory_kib,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
    });
    const challenge = await json(
      assembled,
      new Request('http://127.0.0.1/api/auth/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid }),
      })
    );
    expect(challenge.res.status).toBe(200);
    const challengeId = challenge.body.challenge_id as string;
    const nonce = decodeBase64url(challenge.body.nonce as string);
    const targetPk = decodeBase64url(challenge.body.nodePk as string);
    const sess = generateEd25519KeyPair();
    const del = createDelegation(rootKey, { uid, sessPk: sess.publicKey, now: Date.now() });
    const login = buildLogin({
      challengeId,
      nonce,
      target: nodeId,
      targetPk,
      uid,
      entry: 'self',
    });
    const logged = await assembled.fetch(
      new Request('http://127.0.0.1/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          login: encodeBase64url(encodeLogin(login)),
          sig: encodeBase64url(signLogin(sess.secretKey, login)),
          delegation: encodeBase64url(encodeDelegation(del.delegation)),
          delegation_sig: encodeBase64url(del.sig),
        }),
      }),
      dummyServer
    );
    expect(logged?.status).toBe(200);
    const cookie = logged?.headers.get('set-cookie') ?? '';
    const sid = cookie.match(/tmex_s_self=([^;]*)/)?.[1];
    if (!sid) throw new Error('login did not set cookie');
    return sid;
  }

  test('bootstrap → enable → login 整站门；关闭后恢复开放', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const assembled = await assembleStandalone(db);
      expect(assembled.mesh).toBeNull();

      const openMode = await json(assembled, new Request('http://127.0.0.1/api/auth/mode'));
      expect(openMode.body.mode).toBe('none');
      expect(openMode.body.localAuth).toEqual({
        supported: true,
        enabled: false,
        effective: false,
        credentialsPresent: false,
      });
      const openDevices = await assembled.fetch(
        new Request('http://127.0.0.1/api/devices'),
        dummyServer
      );
      expect(openDevices?.status).toBe(404);
      const openLocal = await json(assembled, new Request('http://127.0.0.1/api/local/status'));
      expect(openLocal.res.status).toBe(200);
      const openWs = await assembled.fetch(new Request('http://127.0.0.1/ws'), dummyServer);
      expect(openWs).toBeUndefined();

      const boot = await json(
        assembled,
        new Request('http://127.0.0.1/api/auth/local/bootstrap', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'owner', password: 'tmex-test-pass' }),
        })
      );
      expect(boot.res.status).toBe(200);

      const enabled = await json(
        assembled,
        new Request('http://127.0.0.1/api/auth/local', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        })
      );
      expect(enabled.res.status).toBe(200);
      expect((enabled.body.localAuth as { effective: boolean }).effective).toBe(true);

      const gatedDevices = await json(assembled, new Request('http://127.0.0.1/api/devices'));
      expect(gatedDevices.res.status).toBe(401);
      const gatedLocal = await json(assembled, new Request('http://127.0.0.1/api/local/status'));
      expect(gatedLocal.res.status).toBe(401);
      const gatedWs = await json(assembled, new Request('http://127.0.0.1/ws'));
      expect(gatedWs.res.status).toBe(401);
      const stillLogin = await assembled.fetch(new Request('http://127.0.0.1/login'), dummyServer);
      expect(await stillLogin?.text()).toBe('spa');

      const mode = await json(assembled, new Request('http://127.0.0.1/api/auth/mode'));
      expect(mode.body.mode).toBe('mesh');
      const uid = mode.body.uid as string;
      const nodeId = mode.body.nodeId as string;
      const kdf = mode.body.kdfParams as {
        salt: string;
        memory_kib: number;
        iterations: number;
        parallelism: number;
      };
      const sid = await loginWithPassword(assembled, uid, 'tmex-test-pass', kdf, nodeId);
      const cookie = { headers: { cookie: `tmex_s_self=${sid}` } };

      const authedDevices = await assembled.fetch(
        new Request('http://127.0.0.1/api/devices', cookie),
        dummyServer
      );
      expect(authedDevices?.status).toBe(404);
      const authedLocal = await json(
        assembled,
        new Request('http://127.0.0.1/api/local/status', cookie)
      );
      expect(authedLocal.res.status).toBe(200);

      const disable = await json(
        assembled,
        new Request('http://127.0.0.1/api/auth/local', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `tmex_s_self=${sid}` },
          body: JSON.stringify({ enabled: false }),
        })
      );
      expect(disable.res.status).toBe(200);
      const restored = await json(assembled, new Request('http://127.0.0.1/api/devices'));
      expect(restored.res.status).toBe(404);
      const restoredLocal = await json(assembled, new Request('http://127.0.0.1/api/local/status'));
      expect(restoredLocal.res.status).toBe(200);
    } finally {
      close();
    }
  });

  test('standalone 生效时未登录 WS upgrade 走 4401；auth-only 不挂 /api/mesh', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const assembled = await assembleStandalone(db);
      await json(
        assembled,
        new Request('http://127.0.0.1/api/auth/local/bootstrap', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'owner', password: 'tmex-test-pass' }),
        })
      );
      await json(
        assembled,
        new Request('http://127.0.0.1/api/auth/local', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        })
      );

      let upgradeData: { kind?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          upgradeData = opts?.data as typeof upgradeData;
          return true;
        },
      } as unknown as Bun.Server<unknown>;
      const ws = await assembled.fetch(new Request('http://127.0.0.1/ws'), server);
      expect(ws).toBeUndefined();
      expect(upgradeData?.kind).toBe(MESH_REJECT_4401_KIND);

      const meshNodes = await assembled.fetch(
        new Request('http://127.0.0.1/api/mesh/nodes'),
        dummyServer
      );
      expect(meshNodes?.status).toBe(401);
    } finally {
      close();
    }
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

describe('assembleTmex Access guard at outermost fetch', () => {
  afterEach(() => {
    resetAccessGuardForTests();
  });

  const ENFORCED = {
    enforceJwt: true,
    configured: true,
    effective: true,
    teamDomain: 'team.cloudflareaccess.com',
    aud: 'aud-1',
  };

  test('header without JWT is 403 before TLS/local/hub handlers', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    let gatewayHits = 0;
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () =>
        fakeGateway({
          handleRequest: () => {
            gatewayHits += 1;
            return new Response('from-gateway');
          },
        }),
    });
    const res = await assembled.fetch(
      new Request('http://localhost/api/devices', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      dummyServer
    );
    expect(res?.status).toBe(403);
    expect(gatewayHits).toBe(0);
  });

  test('valid JWT reaches inner handlers', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    const { privateKey, jwk } = await generateAccessTestKey('asm');
    setAccessGuardFetch(async () => Response.json({ keys: [jwk] }));
    const token = await signAccessJwt(
      privateKey,
      { alg: 'RS256', kid: 'asm', typ: 'JWT' },
      {
        aud: [ENFORCED.aud],
        iss: `https://${ENFORCED.teamDomain}`,
        exp: Math.floor(Date.now() / 1000) + 120,
      }
    );
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      createGatewayRuntime: async () =>
        fakeGateway({
          handleRequest: () => new Response('from-gateway'),
        }),
    });
    const res = await assembled.fetch(
      new Request('http://localhost/api/devices', {
        headers: {
          'cf-connecting-ip': '1.2.3.4',
          'Cf-Access-Jwt-Assertion': token,
        },
      }),
      dummyServer
    );
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('from-gateway');
  });

  test('/hub/uplink without JWT is not blocked by the guard', async () => {
    setAccessGuardSnapshot(() => ENFORCED);
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      hub: fakeHub({
        handleRequest: async () => new Response('uplink-ok'),
      }),
      createGatewayRuntime: async () => fakeGateway(),
    });
    const res = await assembled.fetch(
      new Request('http://localhost/hub/uplink', { headers: { 'cf-connecting-ip': '1.2.3.4' } }),
      dummyServer
    );
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('uplink-ok');
  });
});

describe('assembleTmex domain access guard', () => {
  afterEach(() => {
    resetDomainAccessForTests();
  });

  const HOSTS = ['tmex.example.com'];

  async function assembleDisabled(overrides?: {
    hub?: HubRuntime;
    gateway?: GatewayRuntime;
  }) {
    setDomainAccessGuardForTests({ allowed: false, hosts: HOSTS });
    return assembleTmex({
      roles: { hub: false, node: false },
      serveFrontend: async () => new Response('spa'),
      hub:
        overrides?.hub ??
        fakeHub({
          handleRequest: async (req) =>
            new URL(req.url).pathname === '/hub/uplink' ? new Response('uplink-ok') : undefined,
        }),
      createGatewayRuntime: async () =>
        overrides?.gateway ??
        fakeGateway({
          handleRequest: (req) => {
            const path = new URL(req.url).pathname;
            if (path === '/healthz') {
              return new Response(JSON.stringify({ status: 'ok' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            if (path.startsWith('/api/')) return new Response('api-ok');
            return undefined;
          },
        }),
    });
  }

  test('default allowed does not change public dispatch', async () => {
    const assembled = await assembleTmex({
      roles: { hub: false, node: false },
      serveFrontend: async () => new Response('spa'),
      createGatewayRuntime: async () => fakeGateway(),
    });
    const res = await assembled.fetch(new Request('https://tmex.example.com/'), dummyServer);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('spa');
  });

  test('disabled domain: / is 403 text, /api and /ws are 403 JSON', async () => {
    const assembled = await assembleDisabled();
    const page = await assembled.fetch(new Request('https://tmex.example.com/'), dummyServer);
    expect(page?.status).toBe(403);
    expect(page?.headers.get('content-type')).toContain('text/plain');
    expect(await page?.text()).toBe('Domain access is disabled for this host.');

    const api = await assembled.fetch(new Request('https://tmex.example.com/api/x'), dummyServer);
    expect(api?.status).toBe(403);
    expect(await api?.json()).toEqual({
      error: {
        code: 'DOMAIN_ACCESS_DISABLED',
        message: 'Access through this domain is disabled for this node.',
      },
    });

    const ws = await assembled.fetch(new Request('https://tmex.example.com/ws'), dummyServer);
    expect(ws?.status).toBe(403);
    expect(await ws?.json()).toEqual({
      error: {
        code: 'DOMAIN_ACCESS_DISABLED',
        message: 'Access through this domain is disabled for this node.',
      },
    });
  });

  test('disabled domain: /n/:id/api is 403 JSON; service paths and LAN pass', async () => {
    let hubHits = 0;
    const assembled = await assembleDisabled({
      hub: fakeHub({
        handleRequest: async (req) => {
          if (new URL(req.url).pathname === '/hub/uplink') {
            hubHits += 1;
            return new Response('uplink-ok');
          }
          return undefined;
        },
      }),
    });
    const nodeApi = await assembled.fetch(
      new Request('https://tmex.example.com/n/abc/api/x'),
      dummyServer
    );
    expect(nodeApi?.status).toBe(403);
    expect((await nodeApi?.json()) as { error: { code: string } }).toEqual({
      error: expect.objectContaining({ code: 'DOMAIN_ACCESS_DISABLED' }),
    });

    const health = await assembled.fetch(
      new Request('https://tmex.example.com/healthz'),
      dummyServer
    );
    expect(health?.status).toBe(200);

    const uplink = await assembled.fetch(
      new Request('https://tmex.example.com/hub/uplink'),
      dummyServer
    );
    expect(uplink?.status).toBe(200);
    expect(await uplink?.text()).toBe('uplink-ok');
    expect(hubHits).toBe(1);

    const acme = await assembled.fetch(
      new Request('https://tmex.example.com/.well-known/acme-challenge/tok'),
      dummyServer
    );
    expect(acme?.status).not.toBe(403);

    const redeem = await assembled.fetch(
      new Request('https://tmex.example.com/api/hub/enrollments/redeem', { method: 'POST' }),
      dummyServer
    );
    expect(redeem?.status).toBe(200);
    expect(await redeem?.text()).toBe('api-ok');

    const hubStatus = await assembled.fetch(
      new Request('https://tmex.example.com/api/hub/status'),
      dummyServer
    );
    expect(hubStatus?.status).toBe(200);

    const enroll = await assembled.fetch(
      new Request('https://tmex.example.com/api/hub/enrollments/tok-1'),
      dummyServer
    );
    expect(enroll?.status).toBe(200);

    const lan = await assembled.fetch(
      new Request('https://tmex.example.com/'),
      serverWithClientIp('192.168.1.5')
    );
    expect(lan?.status).toBe(200);
    expect(await lan?.text()).toBe('spa');
  });

  test('peer-inbound via=<nodeId> is not blocked by the public dispatcher guard', async () => {
    const assembled = await assembleDisabled();
    const req = new Request('https://tmex.example.com/api/x');
    setMeshRequestContext(req, { via: 'ab'.repeat(16) });
    const res = await assembled.fetch(req, dummyServer);
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('api-ok');
  });

  test('public client cannot bypass by sending Host localhost or an IP literal', async () => {
    const assembled = await assembleDisabled();
    const publicServer = serverWithClientIp('203.0.113.10');
    const localhostHost = await assembled.fetch(new Request('http://localhost/'), publicServer);
    expect(localhostHost?.status).toBe(403);
    const ipHost = await assembled.fetch(new Request('http://203.0.113.10/'), publicServer);
    expect(ipHost?.status).toBe(403);
  });

  test('loopback and CGNAT clients are allowed; unknown source is 403', async () => {
    const assembled = await assembleDisabled();
    const loopback = await assembled.fetch(
      new Request('https://tmex.example.com/'),
      serverWithClientIp('127.0.0.1')
    );
    expect(loopback?.status).toBe(200);
    const cgnat = await assembled.fetch(
      new Request('https://tmex.example.com/'),
      serverWithClientIp('100.64.1.2')
    );
    expect(cgnat?.status).toBe(200);
    const unknown = await assembled.fetch(
      new Request('https://tmex.example.com/'),
      serverWithClientIp(null)
    );
    expect(unknown?.status).toBe(403);
  });

  test('untrusted spoofed XFF is judged by the socket address', async () => {
    const assembled = await assembleDisabled();
    const lanSocket = await assembled.fetch(
      new Request('https://tmex.example.com/', {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      }),
      serverWithClientIp('10.0.0.8')
    );
    expect(lanSocket?.status).toBe(200);
    const publicSocket = await assembled.fetch(
      new Request('https://tmex.example.com/', {
        headers: { 'x-forwarded-for': '10.0.0.8' },
      }),
      serverWithClientIp('203.0.113.9')
    );
    expect(publicSocket?.status).toBe(403);
  });
});

describe('assembleTmex preflight', () => {
  test('skips mesh/TLS/frontend and only serves /healthz', async () => {
    let meshCalls = 0;
    let frontendCalls = 0;
    let restored = 0;
    const assembled = await assembleTmex({
      runtimeMode: 'preflight',
      roles: { hub: false, node: true },
      createGatewayRuntime: async () =>
        fakeGateway({
          restoreRemoteAgentSessions() {
            restored += 1;
          },
        }),
      createMeshRuntime: async () => {
        meshCalls += 1;
        throw new Error('mesh must not start in preflight');
      },
      serveFrontend: async () => {
        frontendCalls += 1;
        return new Response('fe');
      },
    });
    await assembled.start();
    expect(meshCalls).toBe(0);
    expect(restored).toBe(0);
    const health = await assembled.fetch(new Request('http://127.0.0.1/healthz'), dummyServer);
    expect(health?.status).toBe(200);
    const body = (await health?.json()) as { status: string; version: string; startedAt: number };
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.startedAt).toBe('number');
    const other = await assembled.fetch(
      new Request('http://127.0.0.1/api/system/info'),
      dummyServer
    );
    expect(other?.status).toBe(404);
    expect(frontendCalls).toBe(0);
    await assembled.tls.startup();
    await assembled.stop();
  });
});

describe('assembleTmex multi-hub wiring', () => {
  test('passes a shared MeshHubStore and hub config into createMeshRuntime', async () => {
    const { MeshHubStore } = await import('../../../../apps/gateway/src/auth/mesh-hub-store');
    const { config } = await import('../../../../apps/gateway/src/config');
    let seen: {
      meshHubStore?: unknown;
      hubMode?: unknown;
      hubPriority?: unknown;
      hubWriterEpoch?: unknown;
      hubNodeId?: unknown;
    } = {};
    const hub = fakeHub();
    await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async (opts) => {
        const extra = opts as typeof opts & {
          meshHubStore?: unknown;
          meshHubs?: unknown;
          config: typeof opts.config & {
            hubMode?: unknown;
            hubPriority?: unknown;
            hubWriterEpoch?: unknown;
            hubNodeId?: unknown;
          };
        };
        seen = {
          meshHubStore: extra.meshHubStore,
          hubMode: extra.config.hubMode,
          hubPriority: extra.config.hubPriority,
          hubWriterEpoch: extra.config.hubWriterEpoch,
          hubNodeId: extra.config.hubNodeId,
        };
        expect(extra.meshHubs).toBe(extra.meshHubStore);
        expect(typeof extra.onLocalNodeName).toBe('function');
        return fakeMesh({ hub });
      },
    });
    expect(seen.meshHubStore).toBeInstanceOf(MeshHubStore);
    expect(seen.hubMode).toBe(config.hubMode);
    expect(seen.hubPriority).toBe(config.hubPriority);
    expect(seen.hubWriterEpoch).toBe(config.hubWriterEpoch);
  });

  test('wires mesh onNodeList to hub applyReplicatedNodeList and unsubscribes on stop', async () => {
    const applied: Array<{ list: unknown; meta: unknown }> = [];
    let unsubscribed = 0;
    let subscribed = 0;
    const hub = fakeHub({
      applyReplicatedNodeList(list: unknown, meta: unknown) {
        applied.push({ list, meta });
      },
    } as Partial<HubRuntime>);
    const list = { t: 'node.list', version: 1, nodes: [] };
    const meta = { hubNodeId: 'aa'.repeat(16), generation: 3 };
    const mesh = fakeMesh({
      hub,
      onNodeList(cb: (nextList: unknown, nextMeta: unknown) => void) {
        subscribed += 1;
        cb(list, meta);
        return () => {
          unsubscribed += 1;
        };
      },
    } as Partial<MeshRuntime> & { hub: HubRuntime });
    const assembled = await assembleTmex({
      roles: { hub: true, node: true },
      createGatewayRuntime: async () => fakeGateway(),
      createMeshRuntime: async () => mesh,
    });
    expect(subscribed).toBe(1);
    expect(applied).toEqual([{ list, meta }]);
    await assembled.stop();
    expect(unsubscribed).toBe(1);
    await assembled.stop();
    expect(unsubscribed).toBe(1);
  });

  test('logs [hub] mode/priority/writerEpoch/publicUrl at startup', async () => {
    const { config } = await import('../../../../apps/gateway/src/config');
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      await assembleTmex({
        roles: { hub: true, node: true },
        createGatewayRuntime: async () => fakeGateway(),
        createMeshRuntime: async () => fakeMesh({ hub: fakeHub() }),
      });
    } finally {
      console.log = originalLog;
    }
    const line = lines.find((item) => item.startsWith('[hub] mode='));
    expect(line).toBe(
      `[hub] mode=${config.hubMode} priority=${config.hubPriority} writerEpoch=${config.hubWriterEpoch} publicUrl=${config.hubPublicUrl ?? ''}`
    );
  });
});
