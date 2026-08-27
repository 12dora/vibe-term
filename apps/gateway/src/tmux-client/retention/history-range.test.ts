import { describe, expect, test } from 'bun:test';

import { assembleHistoryChunks, selectHistoryRange, sliceReplayChunk } from './history-range';
import type { ReplayChunk } from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EPOCH_A = new Uint8Array(16).fill(0x11);
const EPOCH_B = new Uint8Array(16).fill(0x22);

function chunk(seqStart: bigint, text: string): ReplayChunk {
  const data = encoder.encode(text);
  return { seqStart, seqEnd: seqStart + BigInt(data.byteLength), data, receivedAt: 0 };
}

const FIRST = chunk(0n, 'ab');
const SECOND = chunk(2n, 'cd');
const CHUNKS = [FIRST, SECOND];

describe('selectHistoryRange', () => {
  const base = {
    paneEpoch: EPOCH_A,
    expectedEpoch: EPOCH_A,
    beforeSeq: 2n,
    latestSeq: 4n,
    oldestSeq: 0n,
    limit: 64,
  };

  test.each([
    {
      name: 'epoch mismatch is a gap',
      input: { ...base, expectedEpoch: EPOCH_B },
      expected: { kind: 'gap' as const, reason: 'epoch_changed' as const },
    },
    {
      name: 'cursor past latest is a pane gap',
      input: { ...base, beforeSeq: 9n },
      expected: { kind: 'gap' as const, reason: 'pane_gap' as const },
    },
    {
      name: 'cursor before oldest is an evicted range',
      input: { ...base, beforeSeq: 1n, oldestSeq: 2n },
      expected: { kind: 'gap' as const, reason: 'cache_evicted' as const },
    },
    {
      name: 'exact oldest seq is a valid empty-capable page',
      input: { ...base, beforeSeq: 0n },
      expected: { kind: 'page' as const, beforeSeq: 0n, oldestSeq: 0n, limit: 64 },
    },
    {
      name: 'mid-chunk cursor is a valid page',
      input: { ...base, beforeSeq: 3n },
      expected: { kind: 'page' as const, beforeSeq: 3n, oldestSeq: 0n, limit: 64 },
    },
  ])('$name', ({ input, expected }) => {
    expect(selectHistoryRange(input)).toEqual(expected);
  });
});

describe('sliceReplayChunk', () => {
  test('returns null when the chunk starts at or after the cursor', () => {
    expect(sliceReplayChunk(SECOND, 2n, 8)).toBeNull();
    expect(sliceReplayChunk(SECOND, 1n, 8)).toBeNull();
  });

  test('takes the prefix before a mid-chunk cursor, limited by remaining bytes', () => {
    const all = sliceReplayChunk(SECOND, 3n, 8);
    expect(all).toEqual({ data: encoder.encode('c'), seqStart: 2n });
    const limited = sliceReplayChunk(FIRST, 2n, 1);
    expect(limited).toEqual({ data: encoder.encode('b'), seqStart: 1n });
  });
});

describe('assembleHistoryChunks', () => {
  test('exact start yields empty data at the cursor', () => {
    const assembled = assembleHistoryChunks(CHUNKS, 0n, 64);
    expect(assembled.seqStart).toBe(0n);
    expect(assembled.data.byteLength).toBe(0);
  });

  test('mid-chunk assembly concatenates earlier bytes in seq order', () => {
    const assembled = assembleHistoryChunks(CHUNKS, 3n, 64);
    expect(decoder.decode(assembled.data)).toBe('abc');
    expect(assembled.seqStart).toBe(0n);
  });

  test('byte limit keeps the tail before the cursor', () => {
    const assembled = assembleHistoryChunks(CHUNKS, 4n, 3);
    expect(decoder.decode(assembled.data)).toBe('bcd');
    expect(assembled.seqStart).toBe(1n);
  });
});
