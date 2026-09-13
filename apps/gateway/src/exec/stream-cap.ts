import { EXEC_CHUNK_BYTES, EXEC_STREAM_CAP_BYTES } from './constants';

export type StreamCap = { sent: number; truncated: boolean };

export function emptyStreamCap(): StreamCap {
  return { sent: 0, truncated: false };
}

export function resolveStreamCap(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return EXEC_STREAM_CAP_BYTES;
  return maxBytes;
}

export function takeStreamBytes(
  cap: StreamCap,
  bytes: Uint8Array,
  chunk = EXEC_CHUNK_BYTES,
  limit = EXEC_STREAM_CAP_BYTES
): Uint8Array[] {
  if (cap.truncated || bytes.byteLength === 0) return [];
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const room = limit - cap.sent;
    if (room <= 0) {
      cap.truncated = true;
      break;
    }
    const n = Math.min(chunk, room, bytes.byteLength - offset);
    out.push(bytes.subarray(offset, offset + n));
    cap.sent += n;
    offset += n;
  }
  if (offset < bytes.byteLength) cap.truncated = true;
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
