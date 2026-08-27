export const OUTPUT_MAX_BYTES = 256 * 1024;

const decoder = new TextDecoder();

export interface ByteOutputBuffer {
  append(data: Uint8Array): void;
  reset(): void;
  decode(): string;
  wasTruncated(): boolean;
}

export function createByteOutputBuffer(maxBytes = OUTPUT_MAX_BYTES): ByteOutputBuffer {
  const chunks: number[] = [];
  let truncated = false;
  return {
    append(data) {
      for (const byte of data) {
        if (chunks.length < maxBytes) {
          chunks.push(byte);
        } else {
          truncated = true;
        }
      }
    },
    reset() {
      chunks.length = 0;
      truncated = false;
    },
    decode() {
      return decoder.decode(new Uint8Array(chunks));
    },
    wasTruncated() {
      return truncated;
    },
  };
}
