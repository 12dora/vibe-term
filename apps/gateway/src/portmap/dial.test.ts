import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { dialTcp, withDeadline } from './dial';
import { destroySocket } from './socket-handlers';

function listenCounting(): {
  port: number;
  opened: () => number;
  closed: () => number;
  stop: () => void;
} {
  const state = { opened: 0, closed: 0 };
  const server = createServer({ allowHalfOpen: true });
  server.on('error', () => {});
  server.on('connection', (socket) => {
    state.opened += 1;
    socket.on('error', () => {});
    socket.on('close', () => {
      state.closed += 1;
    });
  });
  server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('bind failed');
  return {
    port: address.port,
    opened: () => state.opened,
    closed: () => state.closed,
    stop: () => server.close(),
  };
}

describe('portmap dial', () => {
  test('cancelling closes the socket that connects anyway', async () => {
    const server = listenCounting();
    try {
      const dial = dialTcp({ host: '127.0.0.1', port: server.port }, 5_000);
      dial.cancel();
      await expect(dial.result).rejects.toThrow('portmap-dial-cancelled');
      await Bun.sleep(80);
      expect(server.closed()).toBe(server.opened());
    } finally {
      server.stop();
    }
  });

  test('rejects a refused connection', async () => {
    const server = listenCounting();
    const port = server.port;
    server.stop();
    await Bun.sleep(20);
    const dial = dialTcp({ host: '127.0.0.1', port }, 5_000);
    await expect(dial.result).rejects.toThrow();
  });

  test('gives back a usable socket and sets the half-open flag', async () => {
    const server = listenCounting();
    try {
      const socket = await dialTcp({ host: '127.0.0.1', port: server.port }, 2_000).result;
      expect(socket.destroyed).toBe(false);
      expect(socket.allowHalfOpen).toBe(true);
      destroySocket(socket);
    } finally {
      server.stop();
    }
  });

  test('withDeadline hands the late value to the cleanup', async () => {
    const abandoned: string[] = [];
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 60));
    await expect(withDeadline(slow, 10, (value) => abandoned.push(value))).rejects.toThrow(
      'portmap-dial-timeout'
    );
    await Bun.sleep(80);
    expect(abandoned).toEqual(['late']);
  });
});
