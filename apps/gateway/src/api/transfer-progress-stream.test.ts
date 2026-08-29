import { describe, expect, test } from 'bun:test';
import { createNdjsonProgressStream } from './transfer-progress-stream';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('createNdjsonProgressStream', () => {
  test('encodes each emit as a JSON line', async () => {
    const stream = createNdjsonProgressStream({
      start({ emit, close }) {
        emit({ type: 'progress', pct: 10 });
        emit({ type: 'done' });
        close();
      },
    });
    expect(await readAll(stream)).toBe(
      `${JSON.stringify({ type: 'progress', pct: 10 })}\n${JSON.stringify({ type: 'done' })}\n`
    );
  });

  test('emit and close after the controller is closed do not throw', async () => {
    const stream = createNdjsonProgressStream({
      start({ emit, close }) {
        close();
        emit({ type: 'late' });
        close();
      },
    });
    expect(await readAll(stream)).toBe('');
  });

  test('cancel invokes the caller callback only', async () => {
    let cancelled = 0;
    const stream = createNdjsonProgressStream({
      start() {},
      cancel() {
        cancelled += 1;
      },
    });
    await stream.cancel();
    expect(cancelled).toBe(1);
  });

  test('awaits an async start before the stream ends', async () => {
    const stream = createNdjsonProgressStream({
      async start({ emit, close }) {
        await Promise.resolve();
        emit({ type: 'ok' });
        close();
      },
    });
    expect(await readAll(stream)).toBe(`${JSON.stringify({ type: 'ok' })}\n`);
  });
});
