export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractSeqNumbers(text: string, prefix = 'SEQ_'): number[] {
  const re = new RegExp(`${escapeRegExp(prefix)}(\\d+)`, 'g');
  const found = new Set<number>();
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    if (Number.isInteger(n)) found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

export type SeqGapResult = {
  expectCount: number;
  start: number;
  found: number[];
  missing: number[];
  extra: number[];
  contiguous: boolean;
  complete: boolean;
};

export function analyzeSeqCapture(
  text: string,
  expectCount: number,
  prefix = 'SEQ_',
  start = 1
): SeqGapResult {
  const found = extractSeqNumbers(text, prefix);
  const foundSet = new Set(found);
  const missing: number[] = [];
  for (let n = start; n < start + expectCount; n += 1) {
    if (!foundSet.has(n)) missing.push(n);
  }
  const extra = found.filter((n) => n < start || n >= start + expectCount);
  const complete = missing.length === 0;
  return {
    expectCount,
    start,
    found,
    missing,
    extra,
    contiguous: complete,
    complete,
  };
}

export function lastMatchingLine(text: string, pattern: RegExp): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && pattern.test(line)) return line;
  }
  return null;
}
