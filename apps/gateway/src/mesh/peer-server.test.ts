import { afterEach, describe, expect, test } from 'bun:test';
import { PeerServer } from './peer-server';
import { DEFAULT_PEER_BIND_HOSTS } from './types';

describe('PeerServer', () => {
  const servers: PeerServer[] = [];
  afterEach(() => {
    while (servers.length) servers.pop()?.stop();
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
});
