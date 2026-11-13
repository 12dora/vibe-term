import { afterEach, describe, expect, test } from 'bun:test';
import { FRAME_HEADER_SIZE, GCM_TAG_LENGTH, MAX_FRAME_PAYLOAD } from '@vibeterm/shared/link';
import {
  PEER_HANDSHAKE_RATE_LIMIT,
  PEER_PREAUTH_GLOBAL,
  PEER_PREAUTH_PER_IP,
  PEER_WS_MAX_PAYLOAD_LENGTH,
  PeerServer,
  PreauthSocketLimiter,
} from './peer-server';
import { DEFAULT_PEER_BIND_HOSTS } from './types';

describe('PeerServer', () => {
  const servers: PeerServer[] = [];
  afterEach(() => {
    while (servers.length) servers.pop()?.stop();
  });

  test('每 IP 每分钟的握手上限给竞速拨号留出余量', () => {
    expect(PEER_HANDSHAKE_RATE_LIMIT).toBe(30);
  });

  test('defaults to dual-stack bind hosts', () => {
    expect(DEFAULT_PEER_BIND_HOSTS).toEqual(['::', '0.0.0.0']);
  });

  test('tries each bind host and only throws when none succeed', async () => {
    const ok = new PeerServer({
      port: 0,
      hostname: ['256.256.256.256', '127.0.0.1'],
      onAccept() {},
    });
    servers.push(ok);
    const snap = await ok.start();
    expect(snap.port).toBeGreaterThan(0);

    const none = new PeerServer({
      port: 0,
      hostname: ['256.256.256.256'],
      onAccept() {},
    });
    await expect(none.start()).rejects.toThrow(/failed to bind peer server/);
  });

  test('rate-limits only valid WebSocket upgrades, not plain HTTP', async () => {
    const server = new PeerServer({
      port: 0,
      hostname: '127.0.0.1',
      handshakeLimitPerMin: 3,
      onAccept() {},
    });
    servers.push(server);
    const { port } = await server.start();
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/peer`);
      expect(res.status).toBe(426);
    }
    const sockets: WebSocket[] = [];
    const openOne = () =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`);
        sockets.push(ws);
        ws.addEventListener('open', () => resolve(1));
        ws.addEventListener('close', (ev) => resolve(ev.code === 1006 ? 0 : ev.code));
        ws.addEventListener('error', () => resolve(0));
      });
    expect(await openOne()).toBe(1);
    expect(await openOne()).toBe(1);
    expect(await openOne()).toBe(1);
    const fourth = await fetch(`http://127.0.0.1:${port}/peer`, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(fourth.status).toBe(429);
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  test('WS payload cap is the mux frame plus 1 MiB headroom; pre-auth caps', () => {
    expect(PEER_WS_MAX_PAYLOAD_LENGTH).toBe(
      FRAME_HEADER_SIZE + MAX_FRAME_PAYLOAD + GCM_TAG_LENGTH + 1024 * 1024
    );
    expect(PEER_PREAUTH_PER_IP).toBe(16);
    expect(PEER_PREAUTH_GLOBAL).toBe(256);
  });

  test('rejects a fifth concurrent pre-handshake socket from the same IP with 429', async () => {
    const server = new PeerServer({
      port: 0,
      hostname: '127.0.0.1',
      handshakeLimitPerMin: 30,
      preauthPerIp: 4,
      onAccept() {},
    });
    servers.push(server);
    const { port } = await server.start();
    const sockets: WebSocket[] = [];
    const openOne = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`);
        sockets.push(ws);
        ws.addEventListener('open', () => resolve(ws));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    await openOne();
    await openOne();
    await openOne();
    await openOne();
    const fifth = await fetch(`http://127.0.0.1:${port}/peer`, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(fifth.status).toBe(429);
    sockets[0]?.close();
    await Bun.sleep(20);
    const sixth = await openOne();
    expect(sixth.readyState).toBe(WebSocket.OPEN);
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  test('global pre-auth cap rejects even when the per-IP cap still has room', async () => {
    const server = new PeerServer({
      port: 0,
      hostname: '127.0.0.1',
      handshakeLimitPerMin: 30,
      preauthPerIp: 10,
      preauthGlobal: 2,
      onAccept() {},
    });
    servers.push(server);
    const { port } = await server.start();
    const sockets: WebSocket[] = [];
    const openOne = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`);
        sockets.push(ws);
        ws.addEventListener('open', () => resolve(ws));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    await openOne();
    await openOne();
    const third = await fetch(`http://127.0.0.1:${port}/peer`, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(third.status).toBe(429);
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  test('pre-auth slot is released when the handshake completes, not before', async () => {
    const done: Array<() => void> = [];
    const server = new PeerServer({
      port: 0,
      hostname: '127.0.0.1',
      handshakeLimitPerMin: 30,
      preauthPerIp: 2,
      onAccept(_socket, _ip, handshakeDone) {
        done.push(handshakeDone);
      },
    });
    servers.push(server);
    const { port } = await server.start();
    const sockets: WebSocket[] = [];
    const openOne = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`);
        sockets.push(ws);
        ws.addEventListener('open', () => resolve(ws));
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
    const tryUpgrade = () =>
      fetch(`http://127.0.0.1:${port}/peer`, {
        headers: { upgrade: 'websocket', connection: 'upgrade' },
      });
    await openOne();
    await openOne();
    await Bun.sleep(50);
    expect((await tryUpgrade()).status).toBe(429);
    done[0]?.();
    done[0]?.();
    const third = await openOne();
    expect(third.readyState).toBe(WebSocket.OPEN);
    expect((await tryUpgrade()).status).toBe(429);
    for (const ws of sockets) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  });

  test('oversized pre-handshake frame is rejected by maxPayloadLength', async () => {
    const server = new PeerServer({
      port: 0,
      hostname: '127.0.0.1',
      handshakeLimitPerMin: 30,
      onAccept() {},
    });
    servers.push(server);
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/peer`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (ev) => resolve(ev.code));
    });
    ws.send(new Uint8Array(PEER_WS_MAX_PAYLOAD_LENGTH + 1));
    const code = await closed;
    expect(code).not.toBe(1000);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('PreauthSocketLimiter', () => {
  test('per-IP and global caps refuse the extra acquire; release frees the slot', () => {
    const limiter = new PreauthSocketLimiter(2, 3);
    expect(limiter.tryAcquire('203.0.113.10')).toBe(true);
    expect(limiter.tryAcquire('203.0.113.10')).toBe(true);
    expect(limiter.tryAcquire('203.0.113.10')).toBe(false);
    expect(limiter.tryAcquire('198.51.100.8')).toBe(true);
    expect(limiter.tryAcquire('192.0.2.1')).toBe(false);
    limiter.release('203.0.113.10');
    expect(limiter.tryAcquire('192.0.2.1')).toBe(true);
    limiter.release('203.0.113.10');
    limiter.release('198.51.100.8');
    limiter.release('192.0.2.1');
    limiter.release('192.0.2.1');
    expect(limiter.tryAcquire('203.0.113.10')).toBe(true);
  });

  test('a null key counts only against the global cap', () => {
    const limiter = new PreauthSocketLimiter(1, 3);
    expect(limiter.tryAcquire(null)).toBe(true);
    expect(limiter.tryAcquire(null)).toBe(true);
    expect(limiter.tryAcquire('203.0.113.10')).toBe(true);
    expect(limiter.tryAcquire(null)).toBe(false);
    limiter.release(null);
    expect(limiter.tryAcquire(null)).toBe(true);
  });
});
