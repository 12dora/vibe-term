import { describe, expect, test } from 'bun:test';
import { createInMemoryLinkPair } from './in-memory-link';

describe('mux dead-stream delivery', () => {
  test('a listener that resets the stream stops later listeners', async () => {
    const [local, remote] = createInMemoryLinkPair();
    const seen: string[] = [];
    remote.onStream((stream) => {
      seen.push('first');
      stream.reset('stale-link');
    });
    remote.onStream(() => {
      seen.push('second');
    });
    const opened = await local.openStream(new Uint8Array([1]));
    await opened.closed;
    expect(seen).toEqual(['first']);
  });
});
