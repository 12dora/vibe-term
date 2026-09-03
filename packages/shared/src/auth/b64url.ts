import { decodeBase64url } from './encoding';

export function decodeB64url(value: string, expectedLen?: number): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid b64url');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(value);
  } catch {
    throw new Error('invalid b64url');
  }
  if (expectedLen !== undefined && bytes.byteLength !== expectedLen) {
    throw new Error(`expected ${expectedLen} bytes`);
  }
  return bytes;
}
