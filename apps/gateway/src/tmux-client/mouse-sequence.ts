export interface MouseSequence {
  bytes: Uint8Array;
  droppable: boolean;
  motionKey: string | null;
}

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const mousePattern = /\[<(\d+);\d+;\d+([Mm])/y;

export function splitMouseSequences(data: Uint8Array): MouseSequence[] | null {
  if (data[0] !== 0x1b) return null;
  const text = decoder.decode(data);
  const sequences: MouseSequence[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (text.charCodeAt(offset) !== 0x1b) return null;
    mousePattern.lastIndex = offset + 1;
    const match = mousePattern.exec(text);
    if (!match) return null;
    const button = Number(match[1]);
    const end = mousePattern.lastIndex;
    sequences.push({
      bytes: data.slice(offset, end),
      motionKey:
        match[2] === 'M' && button <= 255 && (button & 32) !== 0 && (button & 64) === 0
          ? `${button}:${match[2]}`
          : null,
      droppable: match[2] === 'M' && button >= 64 && button <= 95 && (button & ~28) <= 67,
    });
    offset = end;
  }
  return sequences;
}
