import { describe, expect, test } from 'bun:test';
import { analyzeSeqCapture, extractSeqNumbers, lastMatchingLine } from './seq.ts';

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
