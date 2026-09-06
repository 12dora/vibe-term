import { describe, expect, test } from 'bun:test';
import { isPortFree, isPortListening } from './port-probe';

function withEphemeralListener<T>(fn: (port: number) => T): T {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  try {
    return fn(server.port);
  } finally {
    server.stop(true);
  }
}

describe('portmap port probe', () => {
  test('reports a bound port as taken and a released port as free', () => {
    const port = withEphemeralListener((bound) => {
      expect(isPortFree('127.0.0.1', bound)).toBe(false);
      return bound;
    });
    expect(isPortFree('127.0.0.1', port)).toBe(true);
  });

  test('probing does not keep the port bound', () => {
    const port = withEphemeralListener((bound) => bound);
    expect(isPortFree('127.0.0.1', port)).toBe(true);
    expect(isPortFree('127.0.0.1', port)).toBe(true);
    const server = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    server.stop(true);
  });

  test('target probe sees a listening port and misses a closed one', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      expect(await isPortListening('127.0.0.1', server.port, 1_000)).toBe(true);
    } finally {
      server.stop(true);
    }
    expect(await isPortListening('127.0.0.1', server.port, 1_000)).toBe(false);
  });
});
