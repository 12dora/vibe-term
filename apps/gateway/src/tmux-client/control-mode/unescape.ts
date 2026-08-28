import { BYTE_BACKSLASH } from './types';

function isOctalDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x37;
}

export function unescapeControlModeData(
  line: Uint8Array,
  start: number,
  onInvalidEscape?: () => void
): Uint8Array {
  const firstSlash = line.indexOf(BYTE_BACKSLASH, start);
  if (firstSlash < 0) {
    return line.subarray(start);
  }
  const result = new Uint8Array(line.length - start);
  if (firstSlash > start) {
    result.set(line.subarray(start, firstSlash));
  }
  let written = firstSlash - start;
  let index = firstSlash;
  while (index < line.length) {
    const byte = line[index] as number;
    if (byte !== BYTE_BACKSLASH) {
      result[written] = byte;
      written += 1;
      index += 1;
      continue;
    }
    const d1 = line[index + 1];
    const d2 = line[index + 2];
    const d3 = line[index + 3];
    if (
      d1 !== undefined &&
      d2 !== undefined &&
      d3 !== undefined &&
      isOctalDigit(d1) &&
      isOctalDigit(d2) &&
      isOctalDigit(d3)
    ) {
      result[written] = ((d1 - 0x30) << 6) | ((d2 - 0x30) << 3) | (d3 - 0x30);
      written += 1;
      index += 4;
      continue;
    }
    onInvalidEscape?.();
    result[written] = byte;
    written += 1;
    index += 1;
  }
  return result.subarray(0, written);
}
