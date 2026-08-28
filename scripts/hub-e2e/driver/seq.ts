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

export type SeqSourceResult = SeqGapResult & {
  fromHistory: number;
  fromOutput: number;
};

export function mergeSeqNumbers(history: number[], output: number[]): number[] {
  const found = new Set<number>(history);
  for (const n of output) found.add(n);
  return [...found].sort((a, b) => a - b);
}

function analyzeFound(found: number[], expectCount: number, start = 1): SeqGapResult {
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

export function analyzeSeqCapture(
  text: string,
  expectCount: number,
  prefix = 'SEQ_',
  start = 1
): SeqGapResult {
  return analyzeFound(extractSeqNumbers(text, prefix), expectCount, start);
}

export function analyzeSeqSources(
  historyText: string,
  outputText: string,
  expectCount: number,
  prefix = 'SEQ_',
  start = 1
): SeqSourceResult {
  const historyFound = extractSeqNumbers(historyText, prefix);
  const outputFound = extractSeqNumbers(outputText, prefix);
  return {
    ...analyzeFound(mergeSeqNumbers(historyFound, outputFound), expectCount, start),
    fromHistory: historyFound.length,
    fromOutput: outputFound.length,
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
