import { describe, expect, test } from 'bun:test';
import type { LinkStream } from '@tmex/shared/link';
import { pumpLink, pumpToLink } from './stream-pump';

describe('pumpToLink', () => {
  test('awaits end and reports rejection via onError', async () => {
    const src = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const written: Uint8Array[] = [];
    let ended = false;
    let errors = 0;
    await pumpToLink(
      src.getReader(),
      {
        write: async (bytes) => {
          written.push(bytes);
        },
        end: async () => {
          ended = true;
          throw new Error('end-fail');
        },
      },
      () => {
        errors += 1;
      }
    );
    expect(written).toEqual([new Uint8Array([1, 2])]);
    expect(ended).toBe(true);
    expect(errors).toBe(1);
  });
});

describe('pumpLink', () => {
  test('awaits dst.end rejection and releases the source reader', async () => {
    const readable = new ReadableStream<{ bytes: Uint8Array; head: boolean }>({
      start(controller) {
        controller.enqueue({ bytes: new Uint8Array([1]), head: false });
        controller.close();
      },
    });
    let errors = 0;
    let ended = false;
    await pumpLink(
      { readable } as LinkStream,
      {
        write: async () => {},
        end: async () => {
          ended = true;
          throw new Error('end-fail');
        },
      } as unknown as LinkStream,
      () => {
        errors += 1;
      }
    );
    expect(ended).toBe(true);
    expect(errors).toBe(1);
    expect(() => readable.getReader()).not.toThrow();
  });
});
