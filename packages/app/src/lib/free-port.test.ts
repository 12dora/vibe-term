import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { FREE_PORT_ATTEMPTS, canBindPort, pickFreePort } from './free-port';

function occupied(...ports: number[]) {
  const probed: number[] = [];
  const canBind = async (port: number): Promise<boolean> => {
    probed.push(port);
    return !ports.includes(port);
  };
  return { canBind, probed };
}

describe('pickFreePort', () => {
  test('returns the preferred port when it is free', async () => {
    const { canBind, probed } = occupied();
    expect(await pickFreePort(9883, '127.0.0.1', { flag: 'port', canBind })).toBe(9883);
    expect(probed).toEqual([9883]);
  });

  test('walks upwards past occupied ports', async () => {
    const { canBind } = occupied(9883, 9884);
    expect(await pickFreePort(9883, '127.0.0.1', { flag: 'port', canBind })).toBe(9885);
  });

  test('skips avoided ports without probing them', async () => {
    const { canBind, probed } = occupied(39001);
    const port = await pickFreePort(39001, '0.0.0.0', {
      flag: 'peer-port',
      canBind,
      avoid: [39002],
    });
    expect(port).toBe(39003);
    expect(probed).toEqual([39001, 39003]);
  });

  test('passes the bind host to the probe', async () => {
    const hosts: string[] = [];
    await pickFreePort(9883, '203.0.113.7', {
      flag: 'port',
      canBind: async (_port, host) => {
        hosts.push(host);
        return true;
      },
    });
    expect(hosts).toEqual(['203.0.113.7']);
  });

  test('fails with a clear error after a bounded number of attempts', async () => {
    const probed: number[] = [];
    const promise = pickFreePort(9883, '127.0.0.1', {
      flag: 'port',
      canBind: async (port) => {
        probed.push(port);
        return false;
      },
    });
    await expect(promise).rejects.toThrow(`9883-${9883 + FREE_PORT_ATTEMPTS - 1}`);
    await expect(promise).rejects.toThrow('--port');
    expect(probed).toHaveLength(FREE_PORT_ATTEMPTS);
  });

  test('does not probe beyond 65535', async () => {
    const probed: number[] = [];
    await expect(
      pickFreePort(65534, '127.0.0.1', {
        flag: 'port',
        canBind: async (port) => {
          probed.push(port);
          return false;
        },
      })
    ).rejects.toThrow('65534-65535');
    expect(probed).toEqual([65534, 65535]);
  });
});

describe('pickFreePort errors', () => {
  test('propagates a non-occupied probe error immediately', async () => {
    const probed: number[] = [];
    const failure = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    const promise = pickFreePort(9883, '127.0.0.1', {
      flag: 'port',
      canBind: async (port) => {
        probed.push(port);
        throw failure;
      },
    });
    await expect(promise).rejects.toBe(failure);
    expect(probed).toEqual([9883]);
  });
});

describe('canBindPort', () => {
  test('skips a port that is really occupied', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    try {
      expect(await canBindPort(address.port, '127.0.0.1')).toBe(false);
      const picked = await pickFreePort(address.port, '127.0.0.1', { flag: 'port' });
      expect(picked).toBeGreaterThan(address.port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('reports a free port as bindable', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const { port } = address;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await canBindPort(port, '127.0.0.1')).toBe(true);
  });
});
