import { describe, expect, test } from 'bun:test';
import {
  analyzeSeqCapture,
  analyzeSeqSources,
  extractSeqNumbers,
  lastMatchingLine,
  mergeSeqNumbers,
} from './seq.ts';

describe('extractSeqNumbers', () => {
  test('collects unique SEQ_n in order and ignores duplicates', () => {
    const text = 'SEQ_2\nSEQ_1\nnoise SEQ_2 SEQ_3\nSEQ_10';
    expect(extractSeqNumbers(text)).toEqual([1, 2, 3, 10]);
  });

  test('does not treat SEQ_1 as a prefix of SEQ_10', () => {
    expect(extractSeqNumbers('SEQ_1 SEQ_10 SEQ_11')).toEqual([1, 10, 11]);
  });

  test('honors a custom prefix', () => {
    expect(extractSeqNumbers('N=1 N=2 SEQ_9', 'N=')).toEqual([1, 2]);
  });

  test('returns empty for no matches', () => {
    expect(extractSeqNumbers('hello')).toEqual([]);
  });
});

describe('analyzeSeqCapture', () => {
  test('reports contiguous 1..N with no gaps', () => {
    const text = Array.from({ length: 400 }, (_, i) => `SEQ_${i + 1}`).join('\n');
    const result = analyzeSeqCapture(text, 400);
    expect(result.complete).toBe(true);
    expect(result.contiguous).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.found).toHaveLength(400);
    expect(result.found[0]).toBe(1);
    expect(result.found[399]).toBe(400);
  });

  test('detects interior gaps', () => {
    const text = 'SEQ_1\nSEQ_2\nSEQ_4\nSEQ_5';
    const result = analyzeSeqCapture(text, 5);
    expect(result.complete).toBe(false);
    expect(result.contiguous).toBe(false);
    expect(result.missing).toEqual([3]);
  });

  test('detects missing tail and leading numbers', () => {
    const result = analyzeSeqCapture('SEQ_2 SEQ_3', 4);
    expect(result.missing).toEqual([1, 4]);
    expect(result.complete).toBe(false);
  });

  test('ignores extras beyond expectCount when 1..N are present', () => {
    const result = analyzeSeqCapture('SEQ_1 SEQ_2 SEQ_3 SEQ_99', 3);
    expect(result.complete).toBe(true);
    expect(result.contiguous).toBe(true);
    expect(result.extra).toEqual([99]);
  });

  test('empty capture is a full gap', () => {
    const result = analyzeSeqCapture('', 3);
    expect(result.missing).toEqual([1, 2, 3]);
    expect(result.found).toEqual([]);
    expect(result.complete).toBe(false);
  });
});

describe('lastMatchingLine', () => {
  test('returns the last ice-failed line', () => {
    const text = [
      '[mesh][rtc] dial start',
      '[mesh][rtc] ice failed local=host remote=srflx',
      '[mesh][rtc] fallback relay',
      '[mesh][rtc] ice failed local=srflx remote=relay',
    ].join('\n');
    expect(lastMatchingLine(text, /ice failed/i)).toBe(
      '[mesh][rtc] ice failed local=srflx remote=relay'
    );
  });

  test('returns null when nothing matches', () => {
    expect(lastMatchingLine('nope', /ice failed/i)).toBeNull();
  });
});

describe('mergeSeqNumbers', () => {
  test('unions overlapping history and live sets and sorts unique numbers', () => {
    expect(mergeSeqNumbers([1, 2, 3, 4, 5], [4, 5, 6, 7])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('dedupes identical full-scrollback overlap', () => {
    const history = Array.from({ length: 400 }, (_, i) => i + 1);
    const live = Array.from({ length: 201 }, (_, i) => i + 200);
    const merged = mergeSeqNumbers(history, live);
    expect(merged).toHaveLength(400);
    expect(merged[0]).toBe(1);
    expect(merged[399]).toBe(400);
  });

  test('returns one side when the other is empty', () => {
    expect(mergeSeqNumbers([3, 1, 2], [])).toEqual([1, 2, 3]);
    expect(mergeSeqNumbers([], [2, 2, 1])).toEqual([1, 2]);
  });
});

describe('analyzeSeqSources', () => {
  test('merges overlapping history scrollback with live output without double-counting', () => {
    const history = Array.from({ length: 5 }, (_, i) => `SEQ_${i + 1}`).join('\n');
    const live = Array.from({ length: 6 }, (_, i) => `SEQ_${i + 3}`).join('\n');
    const result = analyzeSeqSources(history, live, 8);
    expect(result.fromHistory).toBe(5);
    expect(result.fromOutput).toBe(6);
    expect(result.found).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.complete).toBe(true);
    expect(result.contiguous).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  test('history-only full scrollback is enough for 1..N', () => {
    const history = Array.from({ length: 400 }, (_, i) => `SEQ_${i + 1}`).join('\n');
    const result = analyzeSeqSources(history, '', 400);
    expect(result.fromHistory).toBe(400);
    expect(result.fromOutput).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.found).toHaveLength(400);
  });

  test('live-only capture still works when history is empty', () => {
    const live = 'SEQ_1 SEQ_2 SEQ_3';
    const result = analyzeSeqSources('', live, 3);
    expect(result.fromHistory).toBe(0);
    expect(result.fromOutput).toBe(3);
    expect(result.complete).toBe(true);
  });

  test('keeps gap detection across the union of both sources', () => {
    const result = analyzeSeqSources('SEQ_1 SEQ_2 SEQ_3', 'SEQ_5 SEQ_6', 6);
    expect(result.fromHistory).toBe(3);
    expect(result.fromOutput).toBe(2);
    expect(result.missing).toEqual([4]);
    expect(result.complete).toBe(false);
    expect(result.contiguous).toBe(false);
    expect(result.found).toEqual([1, 2, 3, 5, 6]);
  });

  test('failover overlap: history 1..400 plus live 200..400 is complete without extras', () => {
    const history = Array.from({ length: 400 }, (_, i) => `SEQ_${i + 1}`).join('\n');
    const live = Array.from({ length: 201 }, (_, i) => `SEQ_${i + 200}`).join('\n');
    const result = analyzeSeqSources(history, live, 400);
    expect(result.fromHistory).toBe(400);
    expect(result.fromOutput).toBe(201);
    expect(result.found).toHaveLength(400);
    expect(result.complete).toBe(true);
    expect(result.contiguous).toBe(true);
    expect(result.extra).toEqual([]);
  });

  test('honors a custom prefix on both sources', () => {
    const result = analyzeSeqSources('N=1 N=2', 'N=2 N=3 SEQ_9', 3, 'N=');
    expect(result.fromHistory).toBe(2);
    expect(result.fromOutput).toBe(2);
    expect(result.found).toEqual([1, 2, 3]);
    expect(result.complete).toBe(true);
  });
});
