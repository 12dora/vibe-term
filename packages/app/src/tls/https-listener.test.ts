import { afterEach, describe, expect, test } from 'bun:test';
import { createCa, issueLeaf } from './cert-authority';
import { HttpsListener } from './https-listener';

const websocket = {
  message() {},
  open() {},
  close() {},
  drain() {},
};

function ephemeralPort(): number {
  return 20000 + Math.floor(Math.random() * 10000);
}

describe('HttpsListener', () => {
  const listeners: HttpsListener[] = [];

  afterEach(async () => {
    while (listeners.length > 0) {
      const listener = listeners.pop();
      await listener?.stop();
    }
  });

  test('serves HTTPS with self-signed material and captures bind failure', async () => {
    const ca = await createCa({ name: 'tmex listener CA' });
    const leaf = await issueLeaf({
      ca,
      sans: ['localhost', '127.0.0.1'],
      days: 398,
    });
    const chain = `${leaf.certPem.trim()}\n${ca.certPem.trim()}\n`;
    const port = ephemeralPort();
    const listener = new HttpsListener({
      fetch: () => new Response('hello-tls'),
      websocket,
    });
    listeners.push(listener);

    await listener.apply({
      port,
      host: '127.0.0.1',
      certPem: chain,
      keyPem: leaf.keyPem,
    });
    expect(listener.state()).toEqual({ running: true, port, error: null });

    const res = await fetch(`https://127.0.0.1:${port}/`, { tls: { ca: ca.certPem } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello-tls');

    const blocker = new HttpsListener({
      fetch: () => new Response('other'),
      websocket,
    });
    listeners.push(blocker);
    await blocker.apply({
      port,
      host: '127.0.0.1',
      certPem: chain,
      keyPem: leaf.keyPem,
    });
    expect(blocker.state().running).toBe(false);
    expect(blocker.state().error).toBeTruthy();

    await listener.apply(null);
    expect(listener.state().running).toBe(false);
    expect(listener.state().error).toBeNull();
  });
});
