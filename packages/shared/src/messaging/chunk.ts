function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeEnd(text: string, start: number, proposedEnd: number): number {
  if (proposedEnd <= start) return start;
  if (proposedEnd >= text.length) return text.length;
  const prev = text.charCodeAt(proposedEnd - 1);
  const next = text.charCodeAt(proposedEnd);
  if (isHighSurrogate(prev) && isLowSurrogate(next)) {
    return proposedEnd - 1;
  }
  return proposedEnd;
}

function hardSplit(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = safeEnd(text, i, Math.min(i + maxChars, text.length));
    if (end <= i) {
      chunks.push(text.slice(i, i + 1));
      i += 1;
      continue;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

function flushBuffer(buffer: string[], chunks: string[]): void {
  if (buffer.length === 0) return;
  chunks.push(buffer.join('\n'));
  buffer.length = 0;
}

function takeLine(line: string, maxChars: number, buffer: string[], chunks: string[]): void {
  if (line.length > maxChars) {
    flushBuffer(buffer, chunks);
    chunks.push(...hardSplit(line, maxChars));
    return;
  }
  if (buffer.length === 0) {
    buffer.push(line);
    return;
  }
  const joined = `${buffer.join('\n')}\n${line}`;
  if (joined.length <= maxChars) {
    buffer.push(line);
    return;
  }
  flushBuffer(buffer, chunks);
  buffer.push(line);
}

export function chunkText(text: string, maxChars: number): string[] {
  if (maxChars < 1) {
    throw new Error('maxChars must be >= 1');
  }
  if (text.length === 0) return [];
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const buffer: string[] = [];
  const parts = text.split('\n');
  for (const line of parts) {
    takeLine(line, maxChars, buffer, chunks);
  }
  flushBuffer(buffer, chunks);
  return chunks;
}
