import { describe, expect, test } from 'bun:test';
import { iterateFrames } from './chunker';

function streamOf(chunks: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const frame of gen) out.push([...frame]);
  return out;
}

describe('iterateFrames', () => {
  test('slices a Blob into exact frames with a short tail', async () => {
    const blob = new Blob([Uint8Array.from([1, 2, 3, 4, 5])]);
    expect(await collect(iterateFrames(blob, 2))).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('regroups stream chunks into exact frames', async () => {
    const stream = streamOf([[1], [2, 3, 4], [5, 6, 7]]);
    expect(await collect(iterateFrames(stream, 3))).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  test('empty sources yield nothing', async () => {
    expect(await collect(iterateFrames(new Blob([]), 4))).toEqual([]);
    expect(await collect(iterateFrames(streamOf([]), 4))).toEqual([]);
  });

  test('hands the caller a cancel handle for stream sources', async () => {
    const holder: { cancel: (() => void) | null } = { cancel: null };
    const gen = iterateFrames(streamOf([[1, 2, 3, 4]]), 2, {
      onCancel: (fn) => {
        holder.cancel = fn;
      },
    });
    await gen.next();
    expect(typeof holder.cancel).toBe('function');
    holder.cancel?.();
    await gen.return(undefined as never);
  });
});
