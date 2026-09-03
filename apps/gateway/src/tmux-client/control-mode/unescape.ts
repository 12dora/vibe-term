import { BYTE_BACKSLASH } from './types';

const EMPTY_SCRATCH = new Uint8Array(0);

function isOctalDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x37;
}

export class ControlModeUnescaper {
  private readonly scratches: Uint8Array[] = [EMPTY_SCRATCH];
  private activeLeases = 0;

  withScratchLease<T>(callback: () => T): T {
    this.activeLeases += 1;
    try {
      return callback();
    } finally {
      this.activeLeases -= 1;
    }
  }

  // 含转义时返回的视图仅在下一次 unescape 前有效，调用方必须同步消费。
  unescape(line: Uint8Array, start: number, onInvalidEscape?: () => void): Uint8Array {
    const firstSlash = line.indexOf(BYTE_BACKSLASH, start);
    if (firstSlash < 0) {
      return line.subarray(start);
    }
    const scratchIndex = Math.max(0, this.activeLeases - 1);
    this.ensureCapacity(scratchIndex, line.length - start);
    const result = this.scratches[scratchIndex] as Uint8Array;
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

  private ensureCapacity(index: number, required: number): void {
    const scratch = this.scratches[index] ?? EMPTY_SCRATCH;
    if (scratch.length >= required) return;
    let capacity = Math.max(256, scratch.length);
    while (capacity < required) capacity *= 2;
    this.scratches[index] = new Uint8Array(capacity);
  }
}

export function unescapeControlModeData(
  line: Uint8Array,
  start: number,
  onInvalidEscape?: () => void
): Uint8Array {
  return new ControlModeUnescaper().unescape(line, start, onInvalidEscape).slice();
}
