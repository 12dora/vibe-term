import { describe, expect, test } from 'bun:test';
import { dialTcp, withDeadline } from './dial';

describe('portmap dial', () => {
  test('cancelling closes the socket that connects anyway', async () => {
    let opened = 0;
    let closed = 0;
    const server = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open() {
          opened += 1;
        },
        close() {
          closed += 1;
        },
        data() {},
      },
    });
    try {
      const dial = dialTcp<undefined>(
        { hostname: '127.0.0.1', port: server.port, socket: { data() {} } },
        5_000
      );
      dial.cancel();
      await expect(dial.result).rejects.toThrow('portmap-dial-cancelled');
      await Bun.sleep(60);
      expect(opened).toBe(1);
      expect(closed).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test('rejects a refused connection', async () => {
    const closedServer = Bun.listen<undefined>({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });
    const port = closedServer.port;
    closedServer.stop(true);
    const dial = dialTcp<undefined>(
      { hostname: '127.0.0.1', port, socket: { data() {}, error() {}, close() {} } },
      5_000
    );
    await expect(dial.result).rejects.toThrow();
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
