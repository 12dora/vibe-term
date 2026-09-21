import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import { encodeJsonBytes } from './ctl';
import { readHttpHead } from './stream-http-head';
import { responseFromHttpHead } from './stream-http-response';

describe('responseFromHttpHead', () => {
  test('rest + 后续字节组成 body；content-length 对齐则成功', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.write(new TextEncoder().encode('AB'));
      await stream.write(
        encodeJsonBytes({
          status: 200,
          headers: { 'content-type': 'text/plain', 'content-length': '4' },
        }),
        { head: true }
      );
      await stream.write(new TextEncoder().encode('CD'));
      await stream.end();
    });
    const stream = await a.openStream(encodeJsonBytes({ type: 'http' }));
    const head = await readHttpHead(stream, { timeoutMs: 1_000 });
    const res = responseFromHttpHead(stream, head, () => {
      stream.reset('aborted');
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ABCD');
  });

  test('content-length 对不上则 body 以 truncated 失败', async () => {
    const [a, b] = createInMemoryLinkPair();
    b.onStream(async (stream) => {
      await stream.write(
        encodeJsonBytes({
          status: 200,
          headers: { 'content-length': '10' },
        }),
        { head: true }
      );
      await stream.write(new TextEncoder().encode('short'));
      await stream.end();
    });
    const stream = await a.openStream(encodeJsonBytes({ type: 'http' }));
    const head = await readHttpHead(stream, { timeoutMs: 1_000 });
    const res = responseFromHttpHead(stream, head, () => {});
    await expect(res.text()).rejects.toThrow(/http body truncated/);
  });
});
