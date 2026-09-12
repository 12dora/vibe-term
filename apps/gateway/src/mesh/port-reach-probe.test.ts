import { afterAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { probeTcpConnect } from './port-reach-probe';

function listen(port = 0): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function boundPort(server: net.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

describe('probeTcpConnect', () => {
  const servers: net.Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  test('open against a local listener', async () => {
    const server = await listen();
    servers.push(server);
    const result = await probeTcpConnect('127.0.0.1', boundPort(server), 500);
    expect(result.verdict).toBe('ok');
    expect(result.connectMs).toBeGreaterThanOrEqual(0);
  });

  test('refused when nothing is listening', async () => {
    const server = await listen();
    const port = boundPort(server);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
    expect(await probeTcpConnect('127.0.0.1', port, 500)).toEqual({
      verdict: 'refused',
      connectMs: null,
    });
  });

  test('timeout when the handshake never completes', async () => {
    expect(
      await probeTcpConnect('203.0.113.9', 9, 40, () => ({
        once() {},
        destroy() {},
      }))
    ).toEqual({ verdict: 'timeout', connectMs: null });
  });
});
