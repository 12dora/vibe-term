import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
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
import { LinkStreamCarrier } from './link-stream-carrier';
import { acceptHttpStream, acceptWsStream, openHttpStream, openWsStream } from './stream-targets';
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
      path: '/api/capabilities',
      origin: 'http://localhost',
      auth: 'test-sid',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { serverImpl?: string };
    expect(body.serverImpl).toBe('tmex-gateway');
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
      clientVersion: 'test',
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
    const res = await handleApiRequest(new Request('http://localhost/api/capabilities'));
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
      clientVersion: 'test',
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
});

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
      clientVersion: 'test',
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
