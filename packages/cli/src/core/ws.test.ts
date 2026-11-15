// 用一个真的（本机回环）ws 服务端验握手：cookie 头、每条连接一个新 cid、4401 的翻译。

import { afterEach, describe, expect, test } from 'bun:test';
import type { AddressInfo } from 'node:net';
import { wsBorsh } from '@vibeterm/shared';
import { generateEd25519KeyPair, popTargetFromUrl, verifyPop } from '@vibeterm/shared/auth';
import { POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { AuthError, NetworkError } from './errors';
import { HttpClient, createMemoryCookieJar } from './http';
import { POP_ERROR_MESSAGE_EN } from './session-pop';
import { nodeGatewayWsUrl, openGatewaySocket } from './ws';

interface Handshake {
  cookie: string | undefined;
  origin: string | undefined;
  cid: string | null;
  pop: string | undefined;
}

interface FakeServer {
  entry: string;
  handshakes: Handshake[];
  close(): Promise<void>;
}

function helloFrame(): Uint8Array {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
    serverImpl: 'fake-gateway',
    serverVersion: '2.0.8',
    selectedVersion: 1,
    maxFrameBytes: 1048576,
    heartbeatIntervalMs: 15000,
    capabilities: ['canonical-state-v1', 'canonical-state-v1.1'],
  });
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_S2C, payload, 1);
}

const servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startServer(
  options: { closeWith?: number; closeReason?: string } = {}
): Promise<FakeServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const handshakes: Handshake[] = [];
  wss.on('connection', (socket: WsSocket, request) => {
    const popHeader = request.headers[POP_HEADER];
    handshakes.push({
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      cid: new URL(request.url ?? '/', 'http://x').searchParams.get('cid'),
      pop: Array.isArray(popHeader) ? popHeader[0] : popHeader,
    });
    if (options.closeWith) {
      socket.close(options.closeWith, options.closeReason ?? 'session invalid');
      return;
    }
    // 客户端先发 HELLO_C2S，收到即回 HELLO_S2C，与真实网关同序。
    socket.once('message', () => socket.send(helloFrame()));
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const server: FakeServer = {
    entry: `http://127.0.0.1:${port}`,
    handshakes,
    // bun 内置的 `ws` 不一定回调 `close()`，别把清理挂在它身上：超时后照样往下走。
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        const timer = setTimeout(resolve, 200);
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
  servers.push(server);
  return server;
}

function httpFor(entry: string): HttpClient {
  const jar = createMemoryCookieJar();
  jar.set('self', 'sid-self', 0);
  jar.set('a'.repeat(32), 'sid-node', 0);
  return new HttpClient({ entry, timeoutMs: 2000, jar, fetchImpl: async () => new Response('{}') });
}

describe('nodeGatewayWsUrl', () => {
  test('maps http/https to ws/wss and keeps the node prefix', () => {
    expect(nodeGatewayWsUrl('http://entry:9883', 'self', 'n1')).toBe('ws://entry:9883/ws?cid=n1');
    expect(nodeGatewayWsUrl('https://entry', 'a'.repeat(32), 'n2')).toBe(
      `wss://entry/n/${'a'.repeat(32)}/ws?cid=n2`
    );
  });
});

describe('openGatewaySocket', () => {
  test('carries the session cookie and the entry origin into the handshake', async () => {
    const server = await startServer();
    const socket = await openGatewaySocket(httpFor(server.entry), 'self', { timeoutMs: 3000 });
    try {
      expect(socket.connection.client.getState()).toBe('READY');
      expect(server.handshakes[0].cookie).toContain('vibeterm_s_self=sid-self');
      expect(server.handshakes[0].origin).toBe(server.entry);
      expect(server.handshakes[0].pop).toBeUndefined();
      expect(socket.cid()).toBe(server.handshakes[0].cid);
      expect(socket.cid()).toBeTruthy();
    } finally {
      socket.close();
    }
  });

  test('sends the target node’s own cookie for /n/<id>/ws', async () => {
    const server = await startServer();
    const node = 'a'.repeat(32);
    const socket = await openGatewaySocket(httpFor(server.entry), node, { timeoutMs: 3000 });
    try {
      expect(server.handshakes[0].cookie).toContain(`vibeterm_s_${node}=sid-node`);
      expect(server.handshakes[0].cookie).toContain('vibeterm_s_self=sid-self');
    } finally {
      socket.close();
    }
  });

  test('every connection gets a fresh cid', async () => {
    const server = await startServer();
    const http = httpFor(server.entry);
    const first = await openGatewaySocket(http, 'self', { timeoutMs: 3000 });
    first.close();
    const second = await openGatewaySocket(http, 'self', { timeoutMs: 3000 });
    second.close();
    expect(server.handshakes).toHaveLength(2);
    expect(server.handshakes[0].cid).not.toBe(server.handshakes[1].cid);
  });

  test('a 4401 close becomes an auth error with a login hint', async () => {
    const server = await startServer({ closeWith: 4401 });
    const error = (await openGatewaySocket(httpFor(server.entry), 'self', {
      timeoutMs: 3000,
    }).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe('run: vibeterm login');
  });

  test('a 4401 close on a node points at that node', async () => {
    const server = await startServer({ closeWith: 4401 });
    const node = 'a'.repeat(32);
    const error = (await openGatewaySocket(httpFor(server.entry), node, {
      timeoutMs: 3000,
    }).catch((err) => err)) as AuthError;
    expect(error.hint).toBe(`run: vibeterm login --node ${node}`);
  });

  test('a 4401 close with POP_REQUIRED is the same PoP error as HTTP', async () => {
    const server = await startServer({ closeWith: 4401, closeReason: 'POP_REQUIRED' });
    const error = (await openGatewaySocket(httpFor(server.entry), 'self', {
      timeoutMs: 3000,
    }).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe('POP_REQUIRED');
    expect(error.message).toBe(POP_ERROR_MESSAGE_EN);
    expect(error.hint).toBe('run: vibeterm login');
    expect(error.message).not.toContain('session invalid');
  });

  test('a 4401 close with POP_INVALID is the same PoP error as HTTP', async () => {
    const server = await startServer({ closeWith: 4401, closeReason: 'POP_INVALID' });
    const error = (await openGatewaySocket(httpFor(server.entry), 'self', {
      timeoutMs: 3000,
    }).catch((err) => err)) as AuthError;
    expect(error.code).toBe('POP_INVALID');
    expect(error.message).toBe(POP_ERROR_MESSAGE_EN);
  });

  test('any other close is a network error', async () => {
    const server = await startServer({ closeWith: 1011 });
    const error = (await openGatewaySocket(httpFor(server.entry), 'self', {
      timeoutMs: 3000,
    }).catch((err) => err)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
  });

  test('adds a verifiable x-vibeterm-pop header when a key exists', async () => {
    const server = await startServer();
    const pair = generateEd25519KeyPair();
    const jar = createMemoryCookieJar();
    jar.set('self', 'sid-self', 0);
    jar.setPopKey('self', { sessSk: pair.secretKey, sessPk: pair.publicKey });
    const http = new HttpClient({
      entry: server.entry,
      timeoutMs: 2000,
      jar,
      fetchImpl: async () => new Response('{}'),
    });
    const socket = await openGatewaySocket(http, 'self', { timeoutMs: 3000 });
    try {
      const handshake = server.handshakes[0];
      expect(handshake.pop).toBeTruthy();
      const upgradeUrl = nodeGatewayWsUrl(server.entry, 'self', handshake.cid ?? '');
      expect(verifyPop(pair.publicKey, handshake.pop, popTargetFromUrl('GET', upgradeUrl)).ok).toBe(
        true
      );
    } finally {
      socket.close();
    }
  });
});
