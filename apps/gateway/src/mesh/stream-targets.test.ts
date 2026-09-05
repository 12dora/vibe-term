import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { handleApiRequest } from '../api';
import { dispatchRoutes } from '../api/route';
import { NODE_SESSION_TTL_MS, NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { runMigrations } from '../db/migrate';
import { createGatewayRuntime } from '../runtime';
import { WebSocketServer } from '../ws';
import {
  CLIENT_SOURCE_LOCAL,
  X_TMEX_CLIENT_SOURCE,
  waivesPasskeySecondFactor,
} from './client-source';
import { LinkStreamCarrier } from './link-stream-carrier';
import { setMeshRequestContext } from './mesh-deps';
import { setShareAccessVerifier, setShareEndedReader } from './share-credential';
import { decodeTerminalStreamClose } from './stream-close-code';
import {
  acceptHttpStream,
  acceptWsStream,
  openHttpStream,
  openWsStream,
  stripForwardedRequestHeaders,
} from './stream-targets';
import { seedUser, waitUntil } from './test-support';
import { requestDispatchContext } from './types';

beforeAll(() => {
  runMigrations();
});

describe('http/ws stream targets', () => {
  const fixtures: Array<{ close: () => void; stop?: () => Promise<void> }> = [];
  afterEach(async () => {
    while (fixtures.length) {
      const item = fixtures.pop();
      await item?.stop?.();
      item?.close();
    }
  });

  test('http round-trip against GatewayRuntime.dispatchHttp', async () => {
    const runtime = await createGatewayRuntime({ runMigrationsOnStart: true });
    fixtures.push({ close: () => {}, stop: () => runtime.stop() });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        dispatchHttp: (req, ctx) => runtime.dispatchHttp(req, ctx),
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/healthz',
      origin: 'http://localhost',
      auth: 'test-sid',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('ok');
  });

  test('http streams request body and maps abort to RST', async () => {
    const [a, b] = createInMemoryLinkPair();
    let seenBody = '';
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({
            ok: true,
            session: { userId: 'user-1' },
          }),
        } as unknown as NodeSessionStore,
        async dispatchHttp(req) {
          seenBody = await req.text();
          return new Response('ok-body', { status: 201, headers: { 'x-echo': '1' } });
        },
      });
    });
    const res = await openHttpStream(
      a,
      {
        method: 'POST',
        path: '/api/echo',
        origin: 'http://localhost',
        auth: 'sid',
        headers: { 'content-type': 'text/plain' },
      },
      new TextEncoder().encode('payload-bytes')
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('ok-body');
    expect(seenBody).toBe('payload-bytes');

    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const ac = new AbortController();
    const pending = openHttpStream(
      a,
      { method: 'POST', path: '/api/echo', origin: 'http://localhost', auth: 'sid' },
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
        },
      }),
      ac.signal
    );
    const peer = await incoming;
    const aborted = new Promise<void>((resolve) => peer.onAbort(resolve));
    ac.abort();
    await Promise.allSettled([pending, aborted]);
    expect((await peer.closed).reason).toBe('rst');
  });

  test('early response RSTs unread request body', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp() {
          return new Response('early', { status: 200 });
        },
      });
    });
    const body = new ReadableStream<Uint8Array>({
      start() {
        // never enqueues or closes — unread request body
      },
    });
    const res = await openHttpStream(
      a,
      { method: 'POST', path: '/api/early', origin: 'http://localhost', auth: 'sid' },
      body
    );
    expect(await res.text()).toBe('early');
  });

  test('ws stream HELLO round-trip through attachStreamSession', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    const sid = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, sid.sid);
    const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'mesh-test',
      clientVersion: '1.1.23',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1);
    await opened.send(frame);
    const reader = opened.readable.getReader();
    const first = await reader.read();
    expect(first.value).toBeDefined();
    const envelope = wsBorsh.decodeEnvelope(first.value as Uint8Array);
    expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    opened.close();
  });

  test('mesh-forwarded WS frame is envelope-decoded exactly once', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    seedUser(new UserStore(db));
    const sid = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, sid.sid);
    const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'mesh-decode-once',
      clientVersion: '1.1.23',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1);
    const decode = spyOn(wsBorsh, 'decodeEnvelopeView');
    await opened.send(frame);
    const reader = opened.readable.getReader();
    const first = await reader.read();
    const inboundDecodes = decode.mock.calls.length;
    decode.mockRestore();
    expect(inboundDecodes).toBe(1);
    expect(first.value).toBeDefined();
    expect(wsBorsh.decodeEnvelope(first.value as Uint8Array).kind).toBe(wsBorsh.KIND_HELLO_S2C);
    opened.close();
  });

  test('mesh-forwarded large WS frame keeps payload bytes', async () => {
    const server = new WebSocketServer();
    const received: Uint8Array[] = [];
    const handleBorsh = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_session, _kind, _seq, payload) => {
        received.push(payload.slice());
      }
    );
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    seedUser(new UserStore(db));
    const sid = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, sid.sid);
    const largePayload = Uint8Array.from({ length: 128 * 1024 }, (_, i) => i & 0xff);
    const frame = wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_INPUT, largePayload, 7);
    const decode = spyOn(wsBorsh, 'decodeEnvelopeView');
    await opened.send(frame);
    await waitUntil(() => received.length >= 1);
    const inboundDecodes = decode.mock.calls.length;
    decode.mockRestore();
    handleBorsh.mockRestore();
    expect(inboundDecodes).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(largePayload);
    opened.close();
  });

  test('openWsStream carries cid as a client nonce for the accepting node', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    const sid = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const seen: Array<{ sid: string; uid: string; via: string; cid?: string }> = [];
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
        onGatewaySession(_session, auth) {
          seen.push(auth);
          return true;
        },
      });
    });
    const opened = await openWsStream(a, sid.sid, 'tab-nonce');
    await waitUntil(() => seen.length === 1, 2_000);
    expect(seen).toEqual([{ sid: sid.sid, uid: 'user-1', via: 'entry-1', cid: 'tab-nonce' }]);
    opened.close();
  });

  test('dispatchHttp via handleApiRequest without a Bun server', async () => {
    const res = await handleApiRequest(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const unknown = await handleApiRequest(new Request('http://localhost/api/does-not-exist'));
    expect(unknown.status).toBe(404);
  });

  test('openHttpStream rejects when the link dies before the response head', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      stream.reset('link-down');
    });
    await expect(
      openHttpStream(a, {
        type: 'http',
        method: 'GET',
        path: '/api/devices',
        origin: 'http://entry',
        auth: null,
      })
    ).rejects.toThrow();
  });

  test('openHttpStream errors the response body when the stream RSTs after the head', async () => {
    const [a, b] = createInMemoryLinkPair();
    const peerReady = Promise.withResolvers<import('@tmex/shared/link').LinkStream>();
    b.onStream(async (stream) => {
      await stream.write(
        new TextEncoder().encode(
          '{"status":200,"headers":{"content-type":"application/octet-stream"}}'
        ),
        { head: true }
      );
      await stream.write(new Uint8Array(2048).fill(7));
      peerReady.resolve(stream);
    });
    const res = await openHttpStream(a, {
      type: 'http',
      method: 'GET',
      path: '/api/bulk',
      origin: 'http://entry',
      auth: null,
    });
    expect(res.status).toBe(200);
    const peer = await peerReady.promise;
    const body = res.arrayBuffer();
    peer.reset('mid-body');
    await expect(body).rejects.toBeDefined();
  });

  test('openHttpStream errors the response body when it ends short of content-length', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.write(
        new TextEncoder().encode(
          '{"status":200,"headers":{"content-length":"1024","content-type":"application/octet-stream"}}'
        ),
        { head: true }
      );
      await stream.write(new Uint8Array(64).fill(1));
      await stream.end();
    });
    const res = await openHttpStream(a, {
      type: 'http',
      method: 'GET',
      path: '/api/bulk',
      origin: 'http://entry',
      auth: null,
    });
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toBeDefined();
  });

  test('openHttpStream delivers a complete body when content-length matches', async () => {
    const [a, b] = createInMemoryLinkPair();
    const payload = new TextEncoder().encode('hello');
    b.onStream(async (stream) => {
      await stream.write(
        new TextEncoder().encode(
          `{"status":200,"headers":{"content-length":"${payload.byteLength}","content-type":"text/plain"}}`
        ),
        { head: true }
      );
      await stream.write(payload);
      await stream.end();
    });
    const res = await openHttpStream(a, {
      type: 'http',
      method: 'GET',
      path: '/api/echo',
      origin: 'http://entry',
      auth: null,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  test('openHttpStream strips hop-by-hop and identity headers from OPEN', async () => {
    const [a, b] = createInMemoryLinkPair();
    let openHeaders: Record<string, string> = {};
    b.onStream((stream) => {
      const parsed = JSON.parse(new TextDecoder().decode(stream.openPayload)) as {
        headers?: Record<string, string>;
      };
      openHeaders = parsed.headers ?? {};
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp() {
          return new Response('ok');
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/api/echo',
      origin: 'http://localhost',
      auth: 'sid',
      headers: {
        cookie: 'secret=1',
        authorization: 'Bearer x',
        host: 'evil.example',
        connection: 'keep-alive',
        upgrade: 'websocket',
        'proxy-authorization': 'basic',
        'x-forwarded-for': '1.2.3.4',
        'x-tmex-via': 'forged',
        'content-type': 'application/json',
        'x-custom': 'keep',
        [X_TMEX_CLIENT_SOURCE]: CLIENT_SOURCE_LOCAL,
      },
    });
    expect(res.status).toBe(200);
    expect(openHeaders.cookie).toBeUndefined();
    expect(openHeaders.authorization).toBeUndefined();
    expect(openHeaders.host).toBeUndefined();
    expect(openHeaders.connection).toBeUndefined();
    expect(openHeaders.upgrade).toBeUndefined();
    expect(openHeaders['proxy-authorization']).toBeUndefined();
    expect(openHeaders['x-forwarded-for']).toBeUndefined();
    expect(openHeaders['x-tmex-via']).toBeUndefined();
    expect(openHeaders['content-type']).toBe('application/json');
    expect(openHeaders['x-custom']).toBe('keep');
    expect(openHeaders[X_TMEX_CLIENT_SOURCE]).toBe(CLIENT_SOURCE_LOCAL);
  });

  test('stripForwardedRequestHeaders 保留 x-tmex-client-source', () => {
    const out = stripForwardedRequestHeaders({
      cookie: 'secret=1',
      authorization: 'Bearer x',
      [X_TMEX_CLIENT_SOURCE]: CLIENT_SOURCE_LOCAL,
      'x-forwarded-for': '1.2.3.4',
      'x-custom': 'keep',
    });
    expect(out[X_TMEX_CLIENT_SOURCE]).toBe(CLIENT_SOURCE_LOCAL);
    expect(out['x-custom']).toBe('keep');
    expect(out.cookie).toBeUndefined();
    expect(out.authorization).toBeUndefined();
    expect(out['x-forwarded-for']).toBeUndefined();
  });

  test('acceptHttpStream 对公开登录路径允许 auth:null，并带上 x-tmex-client-source', async () => {
    for (const path of ['/api/auth/mode', '/api/auth/passkey/login/options']) {
      const [a, b] = createInMemoryLinkPair();
      const dispatched = { path: null as string | null, source: null as string | null };
      b.onStream((stream) => {
        void acceptHttpStream(stream, {
          peerNodeId: 'entry-1',
          sessionStore: {
            verify: () => {
              throw new Error('session auth must be skipped');
            },
          } as unknown as NodeSessionStore,
          async dispatchHttp(req) {
            dispatched.path = new URL(req.url).pathname;
            dispatched.source = req.headers.get(X_TMEX_CLIENT_SOURCE);
            return new Response('ok');
          },
        });
      });
      const res = await openHttpStream(a, {
        method: 'GET',
        path,
        origin: 'http://localhost',
        auth: null,
        headers: { [X_TMEX_CLIENT_SOURCE]: CLIENT_SOURCE_LOCAL },
      });
      expect(res.status).toBe(200);
      expect(dispatched).toEqual({ path, source: CLIENT_SOURCE_LOCAL });
    }
  });

  test('acceptHttpStream 公开路径带 token 仍校验会话，无效 token 退化为匿名', async () => {
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    seedUser(new UserStore(db));
    const sid = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    for (const [auth, expectedUid] of [
      [sid.sid, 'user-1'],
      ['not-a-session', null],
    ] as const) {
      const [a, b] = createInMemoryLinkPair();
      const seen = { uid: undefined as string | null | undefined };
      b.onStream((stream) => {
        void acceptHttpStream(stream, {
          peerNodeId: 'entry-1',
          sessionStore: store,
          async dispatchHttp(_req, ctx) {
            seen.uid = ctx.uid;
            return new Response('ok');
          },
        });
      });
      const res = await openHttpStream(a, {
        method: 'GET',
        path: '/api/auth/mode',
        origin: 'http://localhost',
        auth,
      });
      expect(res.status).toBe(200);
      expect(seen.uid).toBe(expectedUid);
    }
  });

  test('acceptHttpStream 对非公开路径 auth:null 仍 401', async () => {
    const [a, b] = createInMemoryLinkPair();
    let dispatchedPath: string | null = null;
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => {
            throw new Error('session auth must not run when missing');
          },
        } as unknown as NodeSessionStore,
        async dispatchHttp(req) {
          dispatchedPath = new URL(req.url).pathname;
          return new Response('leaked', { status: 200 });
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/api/devices',
      origin: 'http://localhost',
      auth: null,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing auth' });
    expect(dispatchedPath).toBeNull();
  });

  test('acceptHttpStream 把 x-tmex-client-source 带到 inbound peer Request', async () => {
    const [a, b] = createInMemoryLinkPair();
    const seen = { header: null as string | null, waived: false, via: '' };
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp(req, ctx) {
          setMeshRequestContext(req, {
            via: ctx.viaNodeId,
            clientIp: `peer:${ctx.viaNodeId}`,
          });
          seen.header = req.headers.get(X_TMEX_CLIENT_SOURCE);
          seen.via = ctx.viaNodeId;
          seen.waived = waivesPasskeySecondFactor(req);
          return new Response('ok');
        },
      });
    });
    await openHttpStream(a, {
      method: 'GET',
      path: '/api/auth/mode',
      origin: 'http://localhost',
      auth: 'sid',
      headers: { [X_TMEX_CLIENT_SOURCE]: CLIENT_SOURCE_LOCAL },
    });
    expect(seen.header).toBe(CLIENT_SOURCE_LOCAL);
    expect(seen.via).toBe('entry-1');
    expect(seen.waived).toBe(true);
  });

  test('acceptHttpStream never forwards set-cookie and injects session renewal', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({
            ok: true,
            session: { userId: 'user-1' },
            renewedExpiresAt: 1_700_000_000_000,
          }),
        } as unknown as NodeSessionStore,
        async dispatchHttp() {
          return new Response('ok', {
            headers: { 'set-cookie': 'sid=stolen', 'content-type': 'text/plain' },
          });
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/api/echo',
      origin: 'http://localhost',
      auth: 'sid',
    });
    expect(await res.text()).toBe('ok');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-tmex-session-renewed')).toBe('1700000000000');
  });

  test('dispatchHttp ctx.viaNodeId comes from the authenticated link, not OPEN', async () => {
    const [a, b] = createInMemoryLinkPair();
    const seen: { uid?: string | null; viaNodeId?: string } = {};
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp(req, ctx) {
          seen.uid = ctx.uid;
          seen.viaNodeId = ctx.viaNodeId;
          expect(requestDispatchContext.get(req)?.viaNodeId).toBe('entry-1');
          return new Response('ok');
        },
      });
    });
    await openHttpStream(a, {
      method: 'POST',
      path: '/api/auth/login',
      origin: 'http://localhost',
      headers: { 'x-tmex-via': 'forged-node' },
    });
    expect(seen.uid).toBeNull();
    expect(seen.viaNodeId).toBe('entry-1');
  });

  test('acceptHttpStream 写入 x-tmex-mesh-peer 并覆盖 OPEN 里的伪造值', async () => {
    const [a, b] = createInMemoryLinkPair();
    const seen = { peer: null as string | null };
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({
            ok: true,
            session: { userId: 'user-1' },
          }),
        } as unknown as NodeSessionStore,
        async dispatchHttp(req) {
          seen.peer = req.headers.get('x-tmex-mesh-peer');
          return new Response('ok');
        },
      });
    });
    await openHttpStream(a, {
      method: 'POST',
      path: '/api/mesh-internal/tmux/pane-info',
      origin: 'http://localhost',
      headers: { 'x-tmex-mesh-peer': 'forged-node' },
    });
    expect(seen.peer).toBe('entry-1');
  });

  test('dispatchRoutes attaches mesh from requestDispatchContext', async () => {
    const req = new Request('http://localhost/api/x');
    requestDispatchContext.set(req, { uid: 'user-1', viaNodeId: 'node-a' });
    let meshVia: string | undefined;
    const res = await dispatchRoutes(
      req,
      '/api/x',
      [
        {
          method: 'GET',
          path: '/api/x',
          handler: (_req, _params, ctx) => {
            meshVia = ctx.mesh?.viaNodeId;
            return new Response('ok');
          },
        },
      ],
      { path: '/api/x' }
    );
    expect(res?.status).toBe(200);
    expect(meshVia).toBe('node-a');
  });

  test('request body pull reads one LinkStream chunk at a time', async () => {
    const [a, b] = createInMemoryLinkPair();
    let first = '';
    const firstRead = Promise.withResolvers<void>();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp(req) {
          const reader = req.body?.getReader();
          if (!reader) return new Response('no-body', { status: 500 });
          const chunk = await reader.read();
          first = new TextDecoder().decode(chunk.value);
          firstRead.resolve();
          let rest = '';
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            rest += new TextDecoder().decode(next.value);
          }
          return new Response(first + rest, { status: 200 });
        },
      });
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('aaa'));
        await firstRead.promise;
        controller.enqueue(new TextEncoder().encode('bbb'));
        controller.close();
      },
    });
    const res = await openHttpStream(
      a,
      {
        method: 'POST',
        path: '/api/echo',
        origin: 'http://localhost',
        auth: 'sid',
        headers: { 'content-type': 'text/plain' },
      },
      body
    );
    expect(first).toBe('aaa');
    expect(await res.text()).toBe('aaabbb');
  });

  test('infinite upload plus immediate 413 keeps a complete response', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp() {
          return new Response('payload too large', { status: 413 });
        },
      });
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
      },
    });
    const res = await openHttpStream(
      a,
      { method: 'POST', path: '/api/upload', origin: 'http://localhost', auth: 'sid' },
      body
    );
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('payload too large');
  });

  test('WS verifies the session on each frame and RST on revoke', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    const issued = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) => {
      b.onStream((stream) => {
        resolve(stream);
        void acceptWsStream(stream, {
          peerNodeId: 'entry-1',
          sessionStore: store,
          wsServer: server,
        });
      });
    });
    const opened = await openWsStream(a, issued.sid);
    const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'mesh-test',
      clientVersion: '1.1.23',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    await opened.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1));
    const reader = opened.readable.getReader();
    const first = await reader.read();
    expect(first.value).toBeDefined();
    const peer = await incoming;
    store.revoke(issued.sid);
    const aborted = new Promise<void>((resolve) => peer.onAbort(resolve));
    await opened.send(wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, new Uint8Array(0), 2));
    await aborted;
    expect((await opened.stream.closed).reason).toBe('rst');
  });

  test('graceful WS end tears down both directions once', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    const issued = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    const incoming = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, issued.sid);
    const peer = await incoming;
    opened.close();
    await Promise.all([opened.stream.closed, peer.closed]);
    expect((await opened.stream.closed).reason).toBe('end');
    expect((await peer.closed).reason).toBe('end');
  });

  test('expired WS session is rejected using NODE_SESSION_TTL', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    let now = 1_000;
    const issued = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now,
    });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
        now: () => now,
      });
    });
    now += NODE_SESSION_TTL_MS + 1;
    const opened = await openWsStream(a, issued.sid);
    await expect(opened.stream.closed).resolves.toMatchObject({ reason: 'rst' });
  });

  test('HTTP abort cancel() rejection is not unhandled', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'user-1' } }),
        } as unknown as NodeSessionStore,
        async dispatchHttp() {
          return new Response(
            new ReadableStream({
              start() {},
              cancel() {
                return Promise.reject(new Error('cancel-fail'));
              },
            })
          );
        },
      });
    });
    const unhandled = await collectUnhandled(async () => {
      const res = await openHttpStream(a, {
        method: 'GET',
        path: '/api/hang',
        origin: 'http://localhost',
        auth: 'sid',
      });
      await res.body?.cancel();
      await Bun.sleep(30);
    });
    expect(unhandled).toEqual([]);
  });

  test('failed response head cancels the upload and does not unhandle writeBody', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.end();
    });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const unhandled = await collectUnhandled(async () => {
      await expect(
        openHttpStream(
          a,
          { method: 'POST', path: '/api/echo', origin: 'http://localhost', auth: 'sid' },
          body
        )
      ).rejects.toBeDefined();
      await Bun.sleep(20);
    });
    expect(cancelled).toBe(true);
    expect(unhandled).toEqual([]);
  });

  test('GET without body does not unhandle end() when the peer RSTs before head', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      stream.reset('link-down');
    });
    const unhandled = await collectUnhandled(async () => {
      await expect(
        openHttpStream(a, {
          type: 'http',
          method: 'GET',
          path: '/api/devices',
          origin: 'http://entry',
          auth: null,
        })
      ).rejects.toThrow();
    });
    expect(unhandled).toEqual([]);
  });

  test('openWsStream.close end() rejection is not unhandled', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    const sid = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, sid.sid);
    opened.stream.end = () => Promise.reject(new Error('end-fail'));
    const unhandled = await collectUnhandled(async () => {
      opened.close();
      await Bun.sleep(20);
    });
    expect(unhandled).toEqual([]);
  });

  test('mesh-internal path traversal does not skip session auth', async () => {
    const cases = [
      '/api/mesh-internal/../agent/sessions',
      '/api/mesh-internal/%2e%2e/agent/sessions',
      '/api/mesh-internal/foo/../../agent/sessions',
      '/api/mesh-internal/%2e%2e/%2e%2e/agent/sessions',
    ];
    for (const path of cases) {
      const [a, b] = createInMemoryLinkPair();
      let dispatchedPath: string | null = null;
      let verifyCalled = false;
      b.onStream((stream) => {
        void acceptHttpStream(stream, {
          peerNodeId: 'entry-1',
          sessionStore: {
            verify: () => {
              verifyCalled = true;
              return { ok: false, reason: 'missing auth' };
            },
          } as unknown as NodeSessionStore,
          async dispatchHttp(req) {
            dispatchedPath = new URL(req.url).pathname;
            return new Response('leaked', { status: 200 });
          },
        });
      });
      const res = await openHttpStream(a, {
        method: 'GET',
        path,
        origin: 'http://localhost',
        auth: null,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'missing auth' });
      expect(dispatchedPath).toBeNull();
      expect(verifyCalled).toBe(false);
    }
  });

  test('normalised /api/mesh-internal/ still skips session auth', async () => {
    const [a, b] = createInMemoryLinkPair();
    let dispatchedPath: string | null = null;
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => {
            throw new Error('session auth must be skipped');
          },
        } as unknown as NodeSessionStore,
        async dispatchHttp(req) {
          dispatchedPath = new URL(req.url).pathname;
          return new Response('ok', { status: 200 });
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'POST',
      path: '/api/mesh-internal/tmux/pane-info',
      origin: 'http://localhost',
      auth: null,
    });
    expect(res.status).toBe(200);
    expect(dispatchedPath ?? '').toBe('/api/mesh-internal/tmux/pane-info');
  });

  test('WS teardown end() rejection is not unhandled', async () => {
    const server = new WebSocketServer();
    const { db, close } = createMigratedAuthDb();
    fixtures.push({ close });
    const store = new NodeSessionStore(db);
    const userStore = new UserStore(db);
    seedUser(userStore);
    const issued = store.issue({
      userId: 'user-1',
      viaNodeId: 'entry-1',
      sessPublicKey: new Uint8Array(32),
      delegationMethod: 'root',
      now: Date.now(),
    });
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      stream.end = () => Promise.reject(new Error('teardown-end-fail'));
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: store,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, issued.sid);
    const unhandled = await collectUnhandled(async () => {
      opened.close();
      await Bun.sleep(40);
    });
    expect(unhandled).toEqual([]);
  });
});

async function collectUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const events = process as unknown as {
    on(event: string, listener: (reason: unknown) => void): void;
    off(event: string, listener: (reason: unknown) => void): void;
  };
  events.on('unhandledRejection', onUnhandled);
  try {
    await run();
    await Bun.sleep(20);
  } finally {
    events.off('unhandledRejection', onUnhandled);
  }
  return unhandled;
}

describe('LinkStreamCarrier with attachStreamSession', () => {
  test('attachStreamSession routes HELLO without a Bun socket', async () => {
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    const incomingP = new Promise<import('@tmex/shared/link').LinkStream>((resolve) =>
      b.onStream(resolve)
    );
    const out = await a.openStream(new Uint8Array(0));
    const incoming = await incomingP;
    const carrier = new LinkStreamCarrier(incoming);
    const attached = server.attachStreamSession(carrier);
    void (async () => {
      const reader = incoming.readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) attached.onMessage(value.bytes);
        }
      } finally {
        attached.onClose();
      }
    })();
    const helloPayload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'stream',
      clientVersion: '1.1.23',
      maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    });
    await out.write(wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, helloPayload, 1));
    const reader = out.readable.getReader();
    const chunk = await reader.read();
    const envelope = wsBorsh.decodeEnvelope(chunk.value?.bytes as Uint8Array);
    expect(envelope.kind).toBe(wsBorsh.KIND_HELLO_S2C);
    out.end();
  });
});

describe('分享凭证的 mesh 流', () => {
  const SHARE_SCOPE = { shareId: 'sh-1', deviceId: 'dev-1', windowId: 'win-1' };
  const SHARE_TOKEN = 'sh-1.secret';
  const denyAll = {
    verify: () => ({ ok: false, reason: 'unknown' }),
  } as unknown as NodeSessionStore;

  afterEach(() => {
    setShareAccessVerifier(null);
    setShareEndedReader(null);
  });

  test('share: 凭证的 ws 流以分享作用域挂会话，不登记常规会话', async () => {
    setShareAccessVerifier((token) =>
      token === SHARE_TOKEN ? { scope: SHARE_SCOPE, accessId: 'acc-1', expiresAt: 9e12 } : null
    );
    const server = new WebSocketServer();
    let registered = 0;
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: denyAll,
        wsServer: server,
        onGatewaySession: () => {
          registered += 1;
          return true;
        },
      });
    });
    const opened = await openWsStream(a, `share:${SHARE_TOKEN}`);
    await waitUntil(() => server.countShareSessions('sh-1') === 1);
    expect(registered).toBe(0);
    opened.close();
  });

  const acceptShareWs =
    (server: WebSocketServer) => (stream: import('@tmex/shared/link').LinkStream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: denyAll,
        wsServer: server,
      });
    };

  test('无效 share: 凭证的 ws 流用 4401 终止码 RST（Hub 不再 failover）', async () => {
    setShareAccessVerifier(() => null);
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    b.onStream(acceptShareWs(server));
    const opened = await openWsStream(a, 'share:sh-1.bad');
    const info = await opened.stream.closed;
    expect(info.reason).toBe('rst');
    expect(decodeTerminalStreamClose(info.message)).toEqual({
      code: 4401,
      reason: 'SHARE_LOGIN_REQUIRED',
    });
  });

  test('分享已结束时初次握手回 4410 终止码', async () => {
    setShareAccessVerifier(() => null);
    setShareEndedReader((shareId) => shareId === 'sh-1');
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    b.onStream(acceptShareWs(server));
    const opened = await openWsStream(a, 'share:sh-1.stale', undefined, 'sh-1');
    const info = await opened.stream.closed;
    expect(decodeTerminalStreamClose(info.message)).toEqual({
      code: 4410,
      reason: 'SHARE_ENDED',
    });
  });

  test('OPEN 的 share 参数与凭证绑定的分享不符即 4401', async () => {
    setShareAccessVerifier((token) =>
      token === SHARE_TOKEN ? { scope: SHARE_SCOPE, accessId: 'acc-1', expiresAt: 9e12 } : null
    );
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    b.onStream(acceptShareWs(server));
    const opened = await openWsStream(a, `share:${SHARE_TOKEN}`, undefined, 'sh-2');
    const info = await opened.stream.closed;
    expect(decodeTerminalStreamClose(info.message)).toEqual({
      code: 4401,
      reason: 'SHARE_LOGIN_REQUIRED',
    });
    expect(server.countShareSessions('sh-1')).toBe(0);
  });

  test('带 share 参数时常规会话凭证一律不认', async () => {
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptWsStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: {
          verify: () => ({ ok: true, session: { userId: 'u1' } }),
        } as unknown as NodeSessionStore,
        wsServer: server,
      });
    });
    const opened = await openWsStream(a, 'sid-1', undefined, 'sh-1');
    const info = await opened.stream.closed;
    expect(decodeTerminalStreamClose(info.message)).toEqual({
      code: 4401,
      reason: 'SHARE_LOGIN_REQUIRED',
    });
  });

  test('share 参数一致时正常挂上分享会话', async () => {
    setShareAccessVerifier((token) =>
      token === SHARE_TOKEN ? { scope: SHARE_SCOPE, accessId: 'acc-1', expiresAt: 9e12 } : null
    );
    const server = new WebSocketServer();
    const [a, b] = createInMemoryLinkPair();
    b.onStream(acceptShareWs(server));
    const opened = await openWsStream(a, `share:${SHARE_TOKEN}`, undefined, 'sh-1');
    await waitUntil(() => server.countShareSessions('sh-1') === 1);
    opened.close();
  });

  test('失效分享凭证落在分享公开面时降级匿名，并回 x-tmex-clear-share', async () => {
    setShareAccessVerifier(() => null);
    const [a, b] = createInMemoryLinkPair();
    const seen: Array<string | null> = [];
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: denyAll,
        dispatchHttp: async (req) => {
          seen.push(req.headers.get('cookie'));
          return new Response('{}');
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/api/share-access/sh-1',
      origin: 'http://localhost',
      auth: 'share:sh-1.dead',
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toBeNull();
    expect(res.headers.get('x-tmex-clear-share')).toBe('1');
  });

  test('分享公开面外的同前缀路径不再匿名开放', async () => {
    setShareAccessVerifier(() => null);
    const [a, b] = createInMemoryLinkPair();
    let dispatched = 0;
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: denyAll,
        dispatchHttp: async () => {
          dispatched += 1;
          return new Response('{}');
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/api/share-access/sh-1/admin',
      origin: 'http://localhost',
      auth: null,
    });
    expect(res.status).toBe(401);
    expect(dispatched).toBe(0);
  });

  test('share: 凭证的 http 流只放行 /api/share-access/*，并合成 cookie', async () => {
    setShareAccessVerifier((token) =>
      token === SHARE_TOKEN ? { scope: SHARE_SCOPE, accessId: 'acc-1', expiresAt: 9e12 } : null
    );
    const seen: Array<{ cookie: string | null; uid: string | null }> = [];
    const [a, b] = createInMemoryLinkPair();
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: denyAll,
        dispatchHttp: async (req, ctx) => {
          seen.push({ cookie: req.headers.get('cookie'), uid: ctx.uid });
          return new Response('ok');
        },
      });
    });
    const ok = await openHttpStream(a, {
      method: 'GET',
      path: '/api/share-access/sh-1',
      origin: 'http://localhost',
      auth: `share:${SHARE_TOKEN}`,
    });
    expect(ok.status).toBe(200);
    expect(seen[0]?.uid).toBeNull();
    expect(seen[0]?.cookie).toBe(`tmex_sh_entry-1=${SHARE_TOKEN}`);

    const denied = await openHttpStream(a, {
      method: 'GET',
      path: '/api/devices',
      origin: 'http://localhost',
      auth: `share:${SHARE_TOKEN}`,
    });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'share_forbidden' });
    expect(seen.length).toBe(1);
  });

  test('/api/share-access/* 无凭证时匿名放行', async () => {
    const [a, b] = createInMemoryLinkPair();
    let dispatched = 0;
    b.onStream((stream) => {
      void acceptHttpStream(stream, {
        peerNodeId: 'entry-1',
        sessionStore: denyAll,
        dispatchHttp: async (_req, ctx) => {
          dispatched += 1;
          expect(ctx.uid).toBeNull();
          return new Response('ok');
        },
      });
    });
    const res = await openHttpStream(a, {
      method: 'GET',
      path: '/api/share-access/sh-1',
      origin: 'http://localhost',
      auth: null,
    });
    expect(res.status).toBe(200);
    expect(dispatched).toBe(1);
  });
});
