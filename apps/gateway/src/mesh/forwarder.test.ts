import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { LinkSession } from '@tmex/shared/link';
import {
  FakePeers,
  FakeStreams,
  NODE_ID,
  asResponse,
  bootMesh,
  call,
  challengeAndLogin,
  dummyServer,
} from './auth-routes.test';
import { getSelfRewrite } from './forwarder';
import {
  MESH_FORWARD_CSP,
  MESH_FORWARD_WS_KIND,
  MESH_REJECT_4401_KIND,
  type MeshServerWebSocket,
  X_TMEX_SET_SESSION,
  isMeshRewritten,
} from './mesh-deps';
import { WS_CLOSE_LOGIN_REQUIRED } from './mesh-deps';
import { waitUntil } from './test-support';

const OTHER = 'bb'.repeat(16);
const dummyLink = {} as LinkSession;

describe('forwarder', () => {
  test('self fallthrough rewrites path and returns rewritten Request', async () => {
    const mesh = await bootMesh();
    try {
      const req = new Request('http://localhost/n/self/api/devices');
      const res = await mesh.runtime.handleRequest(req, dummyServer);
      expect(isMeshRewritten(res)).toBe(true);
      if (!isMeshRewritten(res)) throw new Error('expected rewrite');
      expect(new URL(res.rewritten.url).pathname).toBe('/api/devices');
      expect(getSelfRewrite(req)).toBe('/api/devices');
      expect(mesh.runtime.rewriteSelf(req)).not.toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('/n/self/api/auth/mode is handled internally', async () => {
    const mesh = await bootMesh();
    try {
      const res = await call(mesh.runtime, 'http://localhost/n/self/api/auth/mode');
      expect(res.status).toBe(200);
      expect((await res.json()).mode).toBe('mesh');
    } finally {
      mesh.close();
    }
  });

  test('unreachable node → 503 NODE_UNREACHABLE', async () => {
    const peers = new FakePeers();
    const mesh = await bootMesh({ peers });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request('http://localhost/n/deadbeefdeadbeefdeadbeefdeadbeef/api/ping'),
          dummyServer
        )
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        code: 'NODE_UNREACHABLE',
        nodeId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      });
    } finally {
      mesh.close();
    }
  });

  test('filters request headers; SVG/HTML → octet-stream attachment; PNG passes; unknown header dropped; CSP set', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response('<svg></svg>', {
      headers: {
        'content-type': 'image/svg+xml',
        'x-evil': '1',
        'cache-control': 'no-store',
        'set-cookie': 'stolen=1',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const svg = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/file`, {
            headers: {
              cookie: 'tmex_s_self=abc',
              authorization: 'Bearer x',
              host: 'evil.example',
              connection: 'keep-alive',
              upgrade: 'websocket',
              'proxy-authorization': 'x',
              'x-forwarded-for': '1.1.1.1',
              accept: 'image/*',
            },
          }),
          dummyServer
        )
      );
      expect(svg.status).toBe(200);
      expect(svg.headers.get('content-type')).toBe('application/octet-stream');
      expect(svg.headers.get('content-disposition')).toBe('attachment');
      expect(svg.headers.get('x-evil')).toBeNull();
      expect(svg.headers.get('set-cookie')).toBeNull();
      expect(svg.headers.get('content-security-policy')).toBe(MESH_FORWARD_CSP);
      expect(svg.headers.get('x-content-type-options')).toBe('nosniff');
      expect(svg.headers.get('cache-control')).toBe('no-store');
      expect(streams.lastOpen?.headers.cookie).toBeUndefined();
      expect(streams.lastOpen?.headers.authorization).toBeUndefined();
      expect(streams.lastOpen?.headers.host).toBeUndefined();
      expect(streams.lastOpen?.headers.connection).toBeUndefined();
      expect(streams.lastOpen?.headers.accept).toBe('image/*');

      streams.nextResponse = new Response('<html></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
      const html = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/page`),
          dummyServer
        )
      );
      expect(html.headers.get('content-type')).toBe('application/octet-stream');
      expect(html.headers.get('content-disposition')).toBe('attachment');

      streams.nextResponse = new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      });
      const png = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/img`),
          dummyServer
        )
      );
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(png.headers.get('content-disposition')).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('401 from target is augmented with NODE_LOGIN_REQUIRED', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ error: 'missing auth' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: 'missing auth',
        code: 'NODE_LOGIN_REQUIRED',
        nodeId: OTHER,
      });
    } finally {
      mesh.close();
    }
  });

  test('x-tmex-set-session becomes Set-Cookie tmex_s_<id> on entry', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ sid: 'abc', expires_at: 1 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [X_TMEX_SET_SESSION]: 'sessidvalue;64800',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }),
          dummyServer
        )
      );
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_${OTHER}=sessidvalue`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Max-Age=64800');
      expect(res.headers.get(X_TMEX_SET_SESSION)).toBeNull();
      expect(streams.lastOpen?.auth).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws pumps frames both ways', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      const { sid } = await challengeAndLogin(mesh.runtime, mesh.boot);
      let data: { kind?: string; token?: string; auth?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(data?.kind).toBe(MESH_FORWARD_WS_KIND);
      expect(streams.wsAuth).toBe('remote-sid');
      expect(streams.wsCid).toBeUndefined();

      const sent: Uint8Array[] = [];
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send(frame: Uint8Array) {
          sent.push(frame);
          return frame.byteLength;
        },
        close() {},
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      mesh.runtime.handleWebSocket.message(ws, new Uint8Array([1, 2, 3]));
      expect(streams.lastWs?.sent[0]).toEqual(new Uint8Array([1, 2, 3]));
      streams.lastWs?.pushFromRemote(new Uint8Array([9, 9]));
      expect(sent[0]).toEqual(new Uint8Array([9, 9]));
      void sid;
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws?cid= passes the client nonce through openWsStream', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams });
    try {
      let data: { kind?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws?cid=tab-nonce`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      expect(data?.kind).toBe(MESH_FORWARD_WS_KIND);
      expect(streams.wsAuth).toBe('remote-sid');
      expect(streams.wsCid).toBe('tab-nonce');
    } finally {
      mesh.close();
    }
  });

  test('/n/:id/ws without cookie closes 4401', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const mesh = await bootMesh({ peers });
    try {
      let data: { kind?: string; auth?: string | null } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const res = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws`),
        server
      );
      expect(res).toBeUndefined();
      expect(data?.kind).toBe(MESH_REJECT_4401_KIND);
      let closed: number | undefined;
      const ws = {
        data: data ?? { kind: MESH_REJECT_4401_KIND, auth: null },
        send() {},
        close(code?: number) {
          closed = code;
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      expect(closed).toBe(WS_CLOSE_LOGIN_REQUIRED);
    } finally {
      mesh.close();
    }
  });

  test('401 augmentation reads at most 64 KiB and drops representation headers', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    const huge = 'x'.repeat(80 * 1024);
    streams.nextResponse = new Response(huge, {
      status: 401,
      headers: {
        'content-type': 'text/plain',
        'content-length': String(huge.length),
        'content-range': 'bytes 0-10/11',
        etag: '"abc"',
        'content-disposition': 'inline',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`),
          dummyServer
        )
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('content-length')).toBeNull();
      expect(res.headers.get('content-range')).toBeNull();
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('content-disposition')).toBeNull();
      const body = (await res.json()) as { message?: string; code: string; nodeId: string };
      expect(body.code).toBe('NODE_LOGIN_REQUIRED');
      expect(body.nodeId).toBe(OTHER);
      expect(body.message?.length).toBe(64 * 1024);
    } finally {
      mesh.close();
    }
  });

  test('logout x-tmex-set-session ;0 clears the target cookie', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        [X_TMEX_SET_SESSION]: ';0',
      },
    });
    const mesh = await bootMesh({ peers, streams });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/logout`, { method: 'POST' }),
          dummyServer
        )
      );
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`tmex_s_${OTHER}=`);
      expect(cookie).toContain('Max-Age=0');
      expect(res.headers.get(X_TMEX_SET_SESSION)).toBeNull();
    } finally {
      mesh.close();
    }
  });

  test('upstream WS abort fails over to another link, replays subscribe, keeps browser open', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const logs: string[] = [];
    const mesh = await bootMesh({
      peers,
      streams,
      sleep: async () => {},
      streamLog: (line) => logs.push(line),
    });
    try {
      let data: { kind?: string; token?: string; auth?: string } | undefined;
      const server = {
        upgrade(_req: Request, opts?: { data?: unknown }) {
          data = opts?.data as typeof data;
          return true;
        },
      };
      const upgrade = await mesh.runtime.handleRequest(
        new Request(`http://localhost/n/${OTHER}/ws?cid=tab-a`, {
          headers: { cookie: `tmex_s_${OTHER}=remote-sid` },
        }),
        server
      );
      expect(upgrade).toBeUndefined();
      let browserClosed: { code?: number; reason?: string } | undefined;
      const sent: Uint8Array[] = [];
      const ws = {
        data: data ?? { kind: MESH_FORWARD_WS_KIND },
        send(frame: Uint8Array) {
          sent.push(frame);
          return frame.byteLength;
        },
        close(code?: number, reason?: string) {
          browserClosed = { code, reason };
        },
      } as MeshServerWebSocket;
      mesh.runtime.handleWebSocket.open(ws);
      const hello = encodeHelloFrame();
      const subscribe = encodeSubscribeFrame('dev-1', ['%1', '%2']);
      mesh.runtime.handleWebSocket.message(ws, hello);
      mesh.runtime.handleWebSocket.message(ws, subscribe);
      expect(streams.wsOpens).toHaveLength(1);
      expect(streams.wsOpens[0]?.link).toBe(dcLink);
      expect(streams.lastWs?.sent[0]).toEqual(hello);
      expect(streams.lastWs?.sent[1]).toEqual(subscribe);

      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      expect(browserClosed).toBeUndefined();
      expect(streams.wsOpens[1]?.link).toBe(relayLink);
      expect(streams.wsOpens[1]?.cid).toBe('tab-a');
      expect(streams.wsOpens[1]?.auth).toBe('remote-sid');
      const replayed = streams.wsOpens[1]?.ws.sent ?? [];
      expect(replayed[0]).toEqual(hello);
      expect(replayed.some((frame) => bytesEqual(frame, subscribe))).toBe(true);
      expect(logs.some((line) => line.includes('[mesh][stream] failover'))).toBe(true);
      expect(logs.some((line) => /from=dc to=relay resumed=2/.test(line))).toBe(true);

      streams.wsOpens[1]?.ws.pushFromRemote(new Uint8Array([9, 9]));
      expect(sent.at(-1)).toEqual(new Uint8Array([9, 9]));
    } finally {
      mesh.close();
    }
  });

  test('legacy failover waits for DEVICE_CONNECTED and snapshot before replaying subscribe', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const logs: string[] = [];
    const mesh = await bootMesh({
      peers,
      streams,
      streamLog: (line) => logs.push(line),
    });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const hello = encodeHelloFrame();
      const connect = encodeDeviceConnectFrame('dev-1', 2);
      const subscribe = encodeSubscribeFrame('dev-1', ['%1']);
      const select = encodeSelectFrame('dev-1', '%1', 4);
      mesh.runtime.handleWebSocket.message(ws, hello);
      mesh.runtime.handleWebSocket.message(ws, connect);
      mesh.runtime.handleWebSocket.message(ws, subscribe);
      mesh.runtime.handleWebSocket.message(ws, select);
      streams.lastWs?.pushFromRemote(encodeHelloS2CFrame());
      streams.lastWs?.pushFromRemote(encodeDeviceConnectedFrame('dev-1'));
      streams.lastWs?.pushFromRemote(encodeStateSnapshotFrame());

      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const replayed = streams.wsOpens[1]?.ws;
      expect(replayed).toBeDefined();
      await waitUntil(() => (replayed?.sent.length ?? 0) >= 1, 2_000);
      replayed?.pushFromRemote(encodeHelloS2CFrame());
      await waitUntil(() => (replayed?.sent.length ?? 0) >= 2, 2_000);
      expect(sentKinds(replayed?.sent ?? [])).toEqual([
        wsBorsh.KIND_HELLO_C2S,
        wsBorsh.KIND_DEVICE_CONNECT,
      ]);
      replayed?.pushFromRemote(encodeDeviceConnectedFrame('dev-1'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(sentKinds(replayed?.sent ?? []).includes(wsBorsh.KIND_TMUX_SUBSCRIBE_PANES)).toBe(
        false
      );
      replayed?.pushFromRemote(encodeStateSnapshotFrame());
      await waitUntil(
        () => sentKinds(replayed?.sent ?? []).includes(wsBorsh.KIND_TMUX_SUBSCRIBE_PANES),
        2_000
      );
      expect(sentKinds(replayed?.sent ?? [])).toEqual([
        wsBorsh.KIND_HELLO_C2S,
        wsBorsh.KIND_DEVICE_CONNECT,
        wsBorsh.KIND_TMUX_SUBSCRIBE_PANES,
        wsBorsh.KIND_TMUX_SELECT,
      ]);
      expect(
        logs.some((line) => /from=dc to=relay resumed=1 mode=legacy panes=%1 cursor=-/.test(line))
      ).toBe(true);
    } finally {
      mesh.close();
    }
  });

  test('canonical pane cursor is patched onto SetPaneSubscriptions during failover', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      const hello = encodeHelloFrame();
      const epoch = new Uint8Array(16).fill(7);
      const pane = { deviceId: 'dev-1', serverEpoch: epoch, paneId: '%1' };
      const subscribe = wsBorsh.encodeEnvelope(
        wsBorsh.KIND_CANONICAL_COMMAND,
        wsBorsh.encodeCanonicalCommandPayload({
          SetPaneSubscriptions: {
            generation: 3n,
            activePanes: [{ pane, cursor: { paneEpoch: epoch, terminalSeq: 10n } }],
            hotPanes: [],
          },
        }),
        4
      );
      mesh.runtime.handleWebSocket.message(ws, hello);
      mesh.runtime.handleWebSocket.message(ws, subscribe);
      streams.lastWs?.pushFromRemote(
        wsBorsh.encodeEnvelope(
          wsBorsh.KIND_CANONICAL_EVENT,
          wsBorsh.encodeCanonicalEventPayload({
            PaneData: {
              pane,
              paneEpoch: epoch,
              seqStart: 39n,
              seqEnd: 40n,
              data: new Uint8Array([1]),
            },
          }),
          8
        )
      );
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      const replayed = streams.wsOpens[1]?.ws.sent ?? [];
      const commandFrame = replayed.find((frame) => {
        try {
          return wsBorsh.decodeEnvelope(frame).kind === wsBorsh.KIND_CANONICAL_COMMAND;
        } catch {
          return false;
        }
      });
      expect(commandFrame).toBeDefined();
      const decoded = wsBorsh.decodeCanonicalCommandPayload(
        wsBorsh.decodeEnvelope(commandFrame as Uint8Array).payload
      );
      expect('SetPaneSubscriptions' in decoded.command).toBe(true);
      if (!('SetPaneSubscriptions' in decoded.command)) throw new Error('expected subscribe');
      const sub = decoded.command.SetPaneSubscriptions;
      expect(sub.generation).toBe(4n);
      expect(sub.activePanes[0]?.cursor?.terminalSeq).toBe(40n);
    } finally {
      mesh.close();
    }
  });

  test('failover retries until a link appears, then resumes; budget exhaustion closes the browser WS', async () => {
    const dcLink = { id: 'dc' } as unknown as LinkSession;
    const relayLink = { id: 'relay' } as unknown as LinkSession;
    const peers = new FakePeers();
    peers.links.set(OTHER, dcLink);
    peers.transport.set(OTHER, 'dc');
    const streams = new FakeStreams();
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const { ws, closed } = await openForwardWs(mesh.runtime, peers, streams, OTHER);
      mesh.runtime.handleWebSocket.message(ws, encodeHelloFrame());
      peers.failGetLink = 2;
      peers.links.set(OTHER, relayLink);
      peers.transport.set(OTHER, 'relay');
      streams.lastWs?.close(1011, 'reset');
      await waitUntil(() => streams.wsOpens.length === 2, 2_000);
      expect(closed()).toBeUndefined();
      expect(streams.wsOpens[1]?.link).toBe(relayLink);
    } finally {
      mesh.close();
    }

    const peersDead = new FakePeers();
    peersDead.links.set(OTHER, dcLink);
    peersDead.transport.set(OTHER, 'dc');
    const streamsDead = new FakeStreams();
    const meshDead = await bootMesh({
      peers: peersDead,
      streams: streamsDead,
      sleep: async () => {},
    });
    try {
      const { ws, closed } = await openForwardWs(meshDead.runtime, peersDead, streamsDead, OTHER);
      peersDead.links.delete(OTHER);
      streamsDead.lastWs?.close(1011, 'reset');
      await waitUntil(() => closed() !== undefined, 2_000);
      expect(closed()?.reason).toBe('failover-exhausted');
    } finally {
      meshDead.close();
    }
  });

  test('GET http forward retries getLink after a transient failure', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, dummyLink);
    peers.failGetLink = 1;
    const streams = new FakeStreams();
    streams.nextResponse = new Response('ok', { headers: { 'content-type': 'text/plain' } });
    const mesh = await bootMesh({ peers, streams, sleep: async () => {} });
    try {
      const res = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/devices`),
          dummyServer
        )
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      mesh.close();
    }
  });
});

function encodeHelloFrame(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'failover-test',
    clientVersion: 'test',
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1);
}

function encodeHelloS2CFrame(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
    serverImpl: 'tmex-gateway',
    serverVersion: 'test',
    selectedVersion: wsBorsh.CURRENT_VERSION,
    maxFrameBytes: wsBorsh.DEFAULT_MAX_FRAME_BYTES,
    heartbeatIntervalMs: 15_000,
    capabilities: [],
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, 1);
}

function encodeDeviceConnectFrame(deviceId: string, seq: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECT,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId }),
    seq
  );
}

function encodeDeviceConnectedFrame(deviceId: string): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECTED,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, { deviceId }),
    2
  );
}

function encodeStateSnapshotFrame(): Uint8Array {
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_STATE_SNAPSHOT, new Uint8Array(), 3);
}

function encodeSubscribeFrame(deviceId: string, paneIds: string[]): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, {
    deviceId,
    paneIds,
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TMUX_SUBSCRIBE_PANES, payload, 2);
}

function encodeSelectFrame(deviceId: string, paneId: string, seq: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_TMUX_SELECT,
    wsBorsh.encodePayload(wsBorsh.schema.TmuxSelectSchema, {
      deviceId,
      windowId: null,
      paneId,
      selectToken: new Uint8Array(16),
      wantHistory: true,
      cols: 120,
      rows: 32,
    }),
    seq
  );
}

function sentKinds(frames: Uint8Array[]): number[] {
  const kinds: number[] = [];
  for (const frame of frames) {
    try {
      kinds.push(wsBorsh.decodeEnvelope(frame).kind);
    } catch {
      // ignore
    }
  }
  return kinds;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function openForwardWs(
  runtime: Awaited<ReturnType<typeof bootMesh>>['runtime'],
  _peers: FakePeers,
  _streams: FakeStreams,
  nodeId: string
): Promise<{
  ws: MeshServerWebSocket;
  closed: () => { code?: number; reason?: string } | undefined;
}> {
  let data: { kind?: string } | undefined;
  const server = {
    upgrade(_req: Request, opts?: { data?: unknown }) {
      data = opts?.data as typeof data;
      return true;
    },
  };
  await runtime.handleRequest(
    new Request(`http://localhost/n/${nodeId}/ws`, {
      headers: { cookie: `tmex_s_${nodeId}=remote-sid` },
    }),
    server
  );
  let browserClosed: { code?: number; reason?: string } | undefined;
  const ws = {
    data: data ?? { kind: MESH_FORWARD_WS_KIND },
    send() {
      return 0;
    },
    close(code?: number, reason?: string) {
      browserClosed = { code, reason };
    },
  } as MeshServerWebSocket;
  runtime.handleWebSocket.open(ws);
  return { ws, closed: () => browserClosed };
}
