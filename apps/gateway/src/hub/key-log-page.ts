import {
  KEY_LOG_PAGE_MAX_BYTES,
  type KeyLogRecordWire,
  bytesToB64url,
  seqToWire,
} from './uplink-protocol';

export type KeyLogPageRecord = {
  seq: bigint;
  bytes: Uint8Array;
  sig: Uint8Array;
};

const te = new TextEncoder();

export function toKeyLogRecordWire(record: KeyLogPageRecord): KeyLogRecordWire {
  return {
    seq: seqToWire(record.seq),
    bytes: bytesToB64url(record.bytes),
    sig: bytesToB64url(record.sig),
  };
}

export function trimKeyLogPageToByteLimit(
  page: readonly KeyLogPageRecord[],
  hasMore: boolean,
  opts?: { id?: string; maxBytes?: number }
): { records: KeyLogRecordWire[]; hasMore: boolean } {
  const maxBytes = opts?.maxBytes ?? KEY_LOG_PAGE_MAX_BYTES;
  const id = opts?.id;
  const wire = page.map(toKeyLogRecordWire);
  const n = wire.length;
  if (n === 0) return { records: wire, hasMore };

  const sizes = wire.map(jsonUtf8Len);
  if (keyLogResByteLength(sizes, n, hasMore, id) <= maxBytes) {
    return { records: wire, hasMore };
  }

  // 整页超限时旧算法会先丢掉最后一条再把 has_more 置 true，不能只改 has_more 来挤进同一前缀
  const envelopeTrue = keyLogResEnvelopeByteLength(true, id);
  let inner = 0;
  let chosen = 0;
  for (let i = 0; i < n - 1; i++) {
    const next = inner + sizes[i] + (i > 0 ? 1 : 0);
    if (envelopeTrue + next > maxBytes) break;
    inner = next;
    chosen = i + 1;
  }
  return { records: wire.slice(0, chosen), hasMore: true };
}

function jsonUtf8Len(value: unknown): number {
  return te.encode(JSON.stringify(value)).byteLength;
}

function keyLogResEnvelopeByteLength(hasMore: boolean, id?: string): number {
  return te.encode(
    JSON.stringify({
      t: 'key.log.res',
      records: [],
      has_more: hasMore,
      ...(id ? { id } : {}),
    })
  ).byteLength;
}

function keyLogResByteLength(
  sizes: readonly number[],
  n: number,
  hasMore: boolean,
  id?: string
): number {
  let inner = 0;
  for (let i = 0; i < n; i++) {
    inner += sizes[i];
    if (i > 0) inner += 1;
  }
  return keyLogResEnvelopeByteLength(hasMore, id) + inner;
}
