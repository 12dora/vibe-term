import { BYTE_LF, MAX_LINE_BYTES } from './types';

export function findByte(line: Uint8Array, byte: number, from: number): number {
  for (let index = from; index < line.length; index += 1) {
    if (line[index] === byte) {
      return index;
    }
  }
  return -1;
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0] as Uint8Array;
  }
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export interface LineFramer {
  push(chunk: Uint8Array): void;
  end(): void;
}

export function createLineFramer(onLine: (line: Uint8Array) => void): LineFramer {
  let pendingChunks: Uint8Array[] = [];
  let pendingLength = 0;
  let discardingOversizedLine = false;
  let warnedOversizedLine = false;

  function takePendingLine(tail: Uint8Array): Uint8Array {
    if (pendingLength === 0) {
      return tail;
    }
    pendingChunks.push(tail);
    const line = concatChunks(pendingChunks, pendingLength + tail.length);
    pendingChunks = [];
    pendingLength = 0;
    return line;
  }

  return {
    push(chunk) {
      let start = 0;
      while (start <= chunk.length) {
        const newlineIndex = findByte(chunk, BYTE_LF, start);
        if (newlineIndex < 0) {
          break;
        }
        const tail = chunk.subarray(start, newlineIndex);
        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          pendingChunks = [];
          pendingLength = 0;
        } else {
          onLine(takePendingLine(tail));
        }
        start = newlineIndex + 1;
      }

      if (start < chunk.length) {
        const rest = chunk.subarray(start);
        if (discardingOversizedLine) {
          return;
        }
        if (pendingLength + rest.length > MAX_LINE_BYTES) {
          if (!warnedOversizedLine) {
            warnedOversizedLine = true;
            console.warn('[tmex] control mode parser dropped oversized line');
          }
          discardingOversizedLine = true;
          pendingChunks = [];
          pendingLength = 0;
          return;
        }
        pendingChunks.push(rest);
        pendingLength += rest.length;
      }
    },
    end() {
      if (discardingOversizedLine || pendingLength === 0) {
        discardingOversizedLine = false;
        pendingChunks = [];
        pendingLength = 0;
        return;
      }
      const line = concatChunks(pendingChunks, pendingLength);
      pendingChunks = [];
      pendingLength = 0;
      onLine(line);
    },
  };
}
