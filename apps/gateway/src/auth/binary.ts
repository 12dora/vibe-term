export function toBuffer(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function toBytes(value: Buffer | Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBuffer(bytes).toString('base64url');
}

export function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
