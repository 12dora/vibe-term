import { decodeBase64url } from '@tmex/shared/auth';
import { json } from './http';

export function requiredStrings<K extends string>(
  body: Record<string, unknown>,
  keys: readonly K[]
): Record<K, string> | null {
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = body[key];
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

export function requireBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

export function decodeB64url(value: string, expectedLen?: number): Uint8Array {
  if (value.length === 0) throw new Error('invalid b64url');
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

export function requireB64url(
  body: Record<string, unknown>,
  key: string,
  expectedLen?: number
): Uint8Array {
  return decodeB64url(requireBodyString(body, key), expectedLen);
}

export function validationError(err: unknown): Response {
  return json({ error: err instanceof Error ? err.message : 'invalid_fields' }, 400);
}
