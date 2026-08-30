import { describe, expect, test } from 'bun:test';
import { type KeyLogPageRecord, trimKeyLogPageToByteLimit } from './key-log-page';
import {
  KEY_LOG_PAGE_MAX_BYTES,
  bytesToB64url,
  encodeUplinkCtl,
  seqToWire,
} from './uplink-protocol';

function rec(seq: number | bigint, payloadLen: number, sigLen = 64): KeyLogPageRecord {
  const n = typeof seq === 'bigint' ? Number(seq) : seq;
  return {
    seq: typeof seq === 'bigint' ? seq : BigInt(seq),
    bytes: new Uint8Array(payloadLen).fill(n & 255),
    sig: new Uint8Array(sigLen).fill(1),
  };
}

function toWire(row: KeyLogPageRecord) {
  return {
    seq: seqToWire(row.seq),
    bytes: bytesToB64url(row.bytes),
    sig: bytesToB64url(row.sig),
  };
}

function legacyTrim(
  page: readonly KeyLogPageRecord[],
  hasMore: boolean,
  opts?: { id?: string; maxBytes?: number }
): { records: ReturnType<typeof toWire>[]; hasMore: boolean } {
  const maxBytes = opts?.maxBytes ?? KEY_LOG_PAGE_MAX_BYTES;
  let records = [...page];
  let more = hasMore;
  while (records.length > 0) {
    const encoded = encodeUplinkCtl({
      t: 'key.log.res',
      records: records.map(toWire),
      has_more: more,
      ...(opts?.id ? { id: opts.id } : {}),
    });
    if (encoded.byteLength <= maxBytes) break;
    records = records.slice(0, -1);
    more = true;
  }
  return { records: records.map(toWire), hasMore: more };
}

function assertMatch(
  page: readonly KeyLogPageRecord[],
  hasMore: boolean,
  opts?: { id?: string; maxBytes?: number }
): void {
  const got = trimKeyLogPageToByteLimit(page, hasMore, opts);
  const want = legacyTrim(page, hasMore, opts);
  expect(got).toEqual(want);
  const encoded = encodeUplinkCtl({
    t: 'key.log.res',
    records: got.records,
    has_more: got.hasMore,
    ...(opts?.id ? { id: opts.id } : {}),
  });
  expect(encoded.byteLength).toBeLessThanOrEqual(opts?.maxBytes ?? KEY_LOG_PAGE_MAX_BYTES);
}

describe('trimKeyLogPageToByteLimit', () => {
  test('empty page keeps has_more', () => {
    assertMatch([], false, { maxBytes: 200 });
    assertMatch([], true, { maxBytes: 200, id: 'p1' });
  });

  test('small page fits without shrinking', () => {
    assertMatch([rec(1, 8), rec(2, 8), rec(3, 8)], false, { maxBytes: 4_000, id: 'ok' });
    assertMatch([rec(1, 8), rec(2, 8)], true, { maxBytes: 4_000 });
  });

  test('drops a suffix so the longest prefix fits', () => {
    const page = [rec(1, 40), rec(2, 40), rec(3, 40), rec(4, 40)];
    assertMatch(page, false, { maxBytes: 420 });
    const got = trimKeyLogPageToByteLimit(page, false, { maxBytes: 420 });
    expect(got.hasMore).toBe(true);
    expect(got.records.length).toBeGreaterThan(0);
    expect(got.records.length).toBeLessThan(page.length);
  });

  test('single oversized record yields empty page with has_more', () => {
    const page = [rec(1, 400)];
    assertMatch(page, false, { maxBytes: 120 });
    const got = trimKeyLogPageToByteLimit(page, false, { maxBytes: 120 });
    expect(got.records).toEqual([]);
    expect(got.hasMore).toBe(true);
  });

  test('oversized first record still drops the whole prefix', () => {
    const page = [rec(1, 400), rec(2, 8), rec(3, 8)];
    assertMatch(page, true, { maxBytes: 120, id: 'x' });
    expect(trimKeyLogPageToByteLimit(page, true, { maxBytes: 120 }).records).toEqual([]);
  });

  test('matches old shrink-from-end algorithm across mixed sizes', () => {
    const fixtures: {
      page: KeyLogPageRecord[];
      hasMore: boolean;
      id?: string;
      maxBytes: number;
    }[] = [
      { page: [rec(1, 1)], hasMore: false, maxBytes: 50 },
      { page: [rec(1, 1)], hasMore: false, maxBytes: 5_000 },
      { page: [rec(1, 80), rec(2, 8), rec(3, 8)], hasMore: false, maxBytes: 300 },
      { page: [rec(1, 8), rec(2, 80), rec(3, 8)], hasMore: true, maxBytes: 300, id: 'mid' },
      { page: [rec(1, 8), rec(2, 8), rec(3, 80)], hasMore: false, maxBytes: 300 },
      {
        page: Array.from({ length: 12 }, (_, i) => rec(i + 1, 24 + (i % 5) * 10)),
        hasMore: false,
        maxBytes: 800,
      },
      { page: [rec(9007199254740993n, 16)], hasMore: false, maxBytes: 400, id: 'big-seq' },
    ];
    for (const f of fixtures) {
      assertMatch(f.page, f.hasMore, { id: f.id, maxBytes: f.maxBytes });
    }
  });

  test('has_more false→true still drops at least one record (1-byte-over envelope)', () => {
    const page = [rec(1, 20), rec(2, 20)];
    const fullFalse = encodeUplinkCtl({
      t: 'key.log.res',
      records: page.map(toWire),
      has_more: false,
    }).byteLength;
    assertMatch(page, false, { maxBytes: fullFalse - 1 });
    const got = trimKeyLogPageToByteLimit(page, false, { maxBytes: fullFalse - 1 });
    expect(got.records.length).toBeLessThan(page.length);
    expect(got.hasMore).toBe(true);
  });

  test('deterministic random pages stay equivalent to the old loop', () => {
    let seed = 0x9e3779b9;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + (next() % 16);
      const page = Array.from({ length: n }, (_, i) => rec(i + 1, 1 + (next() % 90)));
      const maxBytes = 80 + (next() % 900);
      const hasMore = next() % 2 === 0;
      const id = next() % 3 === 0 ? `id-${trial}` : undefined;
      assertMatch(page, hasMore, { id, maxBytes });
    }
  });
});
