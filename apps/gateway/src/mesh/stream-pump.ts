import type { LinkStream } from '@tmex/shared/link';

type Chunk = Uint8Array | { bytes: Uint8Array; head?: boolean };

export async function pumpToLink(
  src: ReadableStreamDefaultReader<Chunk> | Uint8Array | null | undefined,
  dst: Pick<LinkStream, 'write' | 'end'>,
  onError?: () => void,
  stopped?: () => boolean
): Promise<boolean> {
  const reader = src instanceof Uint8Array || !src ? null : src;
  try {
    if (src instanceof Uint8Array && src.byteLength && !stopped?.()) await dst.write(src);
    while (reader && !stopped?.()) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const bytes = value instanceof Uint8Array ? value : value.bytes;
      const head = !(value instanceof Uint8Array) && value.head;
      if (bytes.byteLength || head) await dst.write(bytes, head ? { head: true } : undefined);
    }
    if (!stopped?.()) await dst.end();
    return true;
  } catch {
    onError?.();
    return false;
  }
}

export async function pumpLink(
  src: LinkStream,
  dst: LinkStream,
  onError: () => void
): Promise<void> {
  const reader = src.readable.getReader();
  try {
    await pumpToLink(reader, dst, onError);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
