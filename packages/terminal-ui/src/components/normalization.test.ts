import { describe, expect, test } from 'bun:test';
import { normalizeHistoryForTerminal, normalizeLiveOutputForTerminal } from './normalization';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// 改动前的两趟实现，作为逐字节等价的参照物
function referenceNormalize(
  data: Uint8Array,
  previousEndedWithCR: boolean
): { normalized: Uint8Array; endedWithCR: boolean } {
  let prevWasCR = previousEndedWithCR;
  let extraCRCount = 0;
  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) extraCRCount += 1;
    prevWasCR = byte === 0x0d;
  }
  const endedWithCR = prevWasCR;
  if (extraCRCount === 0) return { normalized: data, endedWithCR };

  const normalized = new Uint8Array(data.length + extraCRCount);
  let writeIndex = 0;
  prevWasCR = previousEndedWithCR;
  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) {
      normalized[writeIndex] = 0x0d;
      writeIndex += 1;
    }
    normalized[writeIndex] = byte;
    writeIndex += 1;
    prevWasCR = byte === 0x0d;
  }
  return { normalized, endedWithCR };
}

const ALPHABET = [0x0a, 0x0d, 0x41, 0x42, 0x1b, 0x00];

function randomBytes(random: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 0x41;
  }
  return bytes;
}

// 线性同余：固定种子，失败可复现
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('normalizeHistoryForTerminal', () => {
  test('keeps intermediate line breaks but should not advance past the last visible row', () => {
    expect(normalizeHistoryForTerminal('row-1\nrow-2\n')).toBe('row-1\r\nrow-2');
  });

  test('normalizes CRLF input without leaving a trailing terminal advance', () => {
    expect(normalizeHistoryForTerminal('row-1\r\nrow-2\r\n')).toBe('row-1\r\nrow-2');
  });
});

describe('normalizeLiveOutputForTerminal', () => {
  test('preserves CRLF chunk boundaries without inserting duplicate CR', () => {
    const first = normalizeLiveOutputForTerminal(new TextEncoder().encode('a\r'), false);
    const second = normalizeLiveOutputForTerminal(
      new TextEncoder().encode('\nb'),
      first.endedWithCR
    );

    expect(decode(first.normalized)).toBe('a\r');
    expect(decode(second.normalized)).toBe('\nb');
  });

  test('无裸 LF 时原样返回入参，不复制', () => {
    const data = new TextEncoder().encode('a\r\nb');
    expect(normalizeLiveOutputForTerminal(data, false).normalized).toBe(data);
  });

  test('空块沿用上一块的 CR 状态', () => {
    expect(normalizeLiveOutputForTerminal(new Uint8Array(0), true).endedWithCR).toBe(true);
    expect(normalizeLiveOutputForTerminal(new Uint8Array(0), false).endedWithCR).toBe(false);
  });

  test('1000 组随机分块与两趟参照实现逐字节一致', () => {
    const random = seededRandom(0x5eed);
    for (let round = 0; round < 1000; round += 1) {
      const chunks = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
        randomBytes(random, Math.floor(random() * 24))
      );
      let expectedCR = false;
      let actualCR = false;
      for (const chunk of chunks) {
        const expected = referenceNormalize(chunk, expectedCR);
        // 暂存区在下一次调用时被覆盖，先复制再比对
        const actual = normalizeLiveOutputForTerminal(chunk, actualCR);
        const actualBytes = actual.normalized.slice();
        expectedCR = expected.endedWithCR;
        actualCR = actual.endedWithCR;
        expect(actualCR).toBe(expectedCR);
        expect(actualBytes).toEqual(expected.normalized.slice());
      }
    }
  });

  test('超过暂存区上限的大块走独立分配且结果正确', () => {
    const data = new Uint8Array(300 * 1024).fill(0x0a);
    const result = normalizeLiveOutputForTerminal(data, false);
    expect(result.normalized.byteLength).toBe(data.length * 2);
    expect(result.normalized[0]).toBe(0x0d);
    expect(result.normalized[1]).toBe(0x0a);
    expect(result.endedWithCR).toBe(false);
  });
});
