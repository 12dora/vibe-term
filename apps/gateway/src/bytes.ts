export function copyBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function bytesHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function truncateUtf8Tail(value: Uint8Array, byteLimit: number): Uint8Array {
  let start = Math.max(0, value.byteLength - byteLimit);
  while (start < value.byteLength && (value[start] ?? 0) >= 0x80 && (value[start] ?? 0) < 0xc0) {
    start += 1;
  }
  return value.slice(start);
}

export function concatBytes(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
