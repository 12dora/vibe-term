import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { readHttpHead } from './stream-http-head';

describe('readHttpHead', () => {
  test('解析 head JSON，head 前的字节进 rest，并丢掉 set-cookie', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.write(new TextEncoder().encode('early'));
      await stream.write(
        encodeJsonBytes({
          status: 201,
          headers: { 'content-type': 'text/plain', 'set-cookie': 'x=1' },
        }),
        { head: true }
      );
      await stream.write(new TextEncoder().encode('body'));
      await stream.end();
    });
    const stream = await a.openStream(encodeJsonBytes({ type: 'http' }));
    const head = await readHttpHead(stream, { timeoutMs: 1_000 });
    expect(head.status).toBe(201);
    expect(head.headers['content-type']).toBe('text/plain');
    expect(head.headers['set-cookie']).toBeUndefined();
    expect(new TextDecoder().decode(head.rest[0])).toBe('early');
  });

  test('超时 RST 为 head-timeout', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(() => {});
    const stream = await a.openStream(encodeJsonBytes({ type: 'http' }));
    await expect(readHttpHead(stream, { timeoutMs: 20 })).rejects.toThrow('http head timeout');
    expect((await stream.closed).reason).toBe('rst');
  });
});
