import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { dialTcp, withDeadline } from './dial';
import { destroySocket } from './socket-handlers';
import { PortMapError } from './types';

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

  test('refuses a forbidden target without connecting', async () => {
    const server = listenCounting();
    try {
      const policy = { selfPorts: () => [server.port], localAddresses: () => [] };
      const dial = dialTcp({ host: '127.0.0.1', port: server.port }, 2_000, policy);
      const err = await dial.result.then(
        () => null,
        (reason: unknown) => reason
      );
      expect(err).toBeInstanceOf(PortMapError);
      expect((err as PortMapError).code).toBe('target_forbidden');
      await Bun.sleep(50);
      expect(server.opened()).toBe(0);
    } finally {
      server.stop();
    }
  });

  test('refuses cloud metadata addresses', async () => {
    const dial = dialTcp({ host: '169.254.169.254', port: 80 }, 2_000);
    await expect(dial.result).rejects.toThrow(/not an allowed port map target/);
  });

  test('connects to the checked address instead of resolving the hostname again', async () => {
    const server = listenCounting();
    try {
      const resolved: string[] = [];
      const policy = {
        resolver: async (host: string) => {
          resolved.push(host);
          return ['127.0.0.1'];
        },
        selfPorts: () => [],
        localAddresses: () => [],
      };
      const socket = await dialTcp({ host: 'echo.example.com', port: server.port }, 2_000, policy)
        .result;
      expect(resolved).toEqual(['echo.example.com']);
      expect(socket.remoteAddress).toBe('127.0.0.1');
      destroySocket(socket);
    } finally {
      server.stop();
    }
  });

  test('cancelling during resolution never opens a socket', async () => {
    const server = listenCounting();
    try {
      let release: (addresses: string[]) => void = () => {};
      const policy = {
        resolver: () =>
          new Promise<string[]>((resolve) => {
            release = resolve;
          }),
        selfPorts: () => [],
        localAddresses: () => [],
      };
      const dial = dialTcp({ host: 'slow.example.com', port: server.port }, 2_000, policy);
      dial.cancel();
      await expect(dial.result).rejects.toThrow('portmap-dial-cancelled');
      release(['127.0.0.1']);
      await Bun.sleep(50);
      expect(server.opened()).toBe(0);
    } finally {
      server.stop();
    }
  });

  test('the timeout covers a slow resolution', async () => {
    const policy = {
      resolver: () => new Promise<string[]>(() => {}),
      selfPorts: () => [],
      localAddresses: () => [],
    };
    const dial = dialTcp({ host: 'hang.example.com', port: 22 }, 30, policy);
    await expect(dial.result).rejects.toThrow('portmap-dial-timeout');
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
