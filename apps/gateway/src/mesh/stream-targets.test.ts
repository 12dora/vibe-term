import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { createInMemoryLinkPair } from '@tmex/shared/link';
import { handleApiRequest } from '../api';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { runMigrations } from '../db/migrate';
import { createGatewayRuntime } from '../runtime';
import { WebSocketServer } from '../ws';
import { LinkStreamCarrier } from './link-stream-carrier';
import { acceptHttpStream, acceptWsStream, openHttpStream, openWsStream } from './stream-targets';
import { seedUser } from './test-support';

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

  test('dispatchHttp via handleApiRequest without a Bun server', async () => {
    const res = await handleApiRequest(new Request('http://localhost/api/capabilities'));
    expect(res.status).toBe(200);
    const unknown = await handleApiRequest(new Request('http://localhost/api/does-not-exist'));
    expect(unknown.status).toBe(404);
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
