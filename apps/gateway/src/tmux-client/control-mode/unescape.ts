import { BYTE_BACKSLASH } from './types';

const EMPTY_SCRATCH = new Uint8Array(0);

function isOctalDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x37;
}

export class ControlModeUnescaper {
  private scratch = EMPTY_SCRATCH;

  // 含转义时返回的视图仅在下一次 unescape 前有效，调用方必须同步消费。
  unescape(line: Uint8Array, start: number, onInvalidEscape?: () => void): Uint8Array {
    const firstSlash = line.indexOf(BYTE_BACKSLASH, start);
    if (firstSlash < 0) {
      return line.subarray(start);
    }
    this.ensureCapacity(line.length - start);
    const result = this.scratch;
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

  private ensureCapacity(required: number): void {
    if (this.scratch.length >= required) return;
    let capacity = Math.max(256, this.scratch.length);
    while (capacity < required) capacity *= 2;
    this.scratch = new Uint8Array(capacity);
  }
}

const defaultUnescaper = new ControlModeUnescaper();

export function unescapeControlModeData(
  line: Uint8Array,
  start: number,
  onInvalidEscape?: () => void
): Uint8Array {
  return defaultUnescaper.unescape(line, start, onInvalidEscape);
}
