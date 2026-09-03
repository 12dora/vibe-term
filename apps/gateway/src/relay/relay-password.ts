import {
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  deriveSeed,
  encodeBase64url,
  randomBytes,
  sha256,
} from '@tmex/shared/auth';
import { RELAY_ADMIN_TOKEN_BYTES, RELAY_TENANT_ID_BYTES, RELAY_TOKEN_BYTES } from './types';

export const RELAY_PASSWORD_SALT_LENGTH = 16;

export type RelayArgon2idParams = {
  memoryKib?: number;
  iterations?: number;
  parallelism?: number;
};

type StoredRelayPassword = {
  kdf: 'argon2id';
  salt: string;
  hash: string;
  memoryKib: number;
  iterations: number;
  parallelism: number;
};

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function fromHex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function derive(password: string, salt: Uint8Array, params: StoredRelayPassword) {
  return deriveSeed(password, {
    salt,
    memory_kib: params.memoryKib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  });
}

/** 中继全站口令：argon2id（与根密钥同参数），落库形态是自描述 JSON。 */
export async function hashRelayPassword(
  password: string,
  overrides?: RelayArgon2idParams
): Promise<string> {
  const salt = randomBytes(RELAY_PASSWORD_SALT_LENGTH);
  const params: StoredRelayPassword = {
    kdf: 'argon2id',
    salt: toHex(salt),
    hash: '',
    memoryKib: overrides?.memoryKib ?? ARGON2ID_MEMORY_KIB,
    iterations: overrides?.iterations ?? ARGON2ID_ITERATIONS,
    parallelism: overrides?.parallelism ?? ARGON2ID_PARALLELISM,
  };
  const digest = await derive(password, salt, params);
  return JSON.stringify({ ...params, hash: toHex(digest) } satisfies StoredRelayPassword);
}

function parseStored(stored: string): StoredRelayPassword | null {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (rec.kdf !== 'argon2id') return null;
    const { salt, hash, memoryKib, iterations, parallelism } = rec;
    if (typeof salt !== 'string' || typeof hash !== 'string') return null;
    if (!/^([0-9a-f]{2})+$/.test(salt) || !/^([0-9a-f]{2})+$/.test(hash)) return null;
    if (
      typeof memoryKib !== 'number' ||
      typeof iterations !== 'number' ||
      typeof parallelism !== 'number'
    ) {
      return null;
    }
    return { kdf: 'argon2id', salt, hash, memoryKib, iterations, parallelism };
  } catch {
    return null;
  }
}

export async function verifyRelayPassword(stored: string, password: string): Promise<boolean> {
  const params = parseStored(stored);
  if (!params) return false;
  let digest: Uint8Array;
  try {
    digest = await derive(password, fromHex(params.salt), params);
  } catch {
    return false;
  }
  return constantTimeEqual(toHex(digest), params.hash);
}

/** 长度不同直接短路（长度本身不是秘密），长度相同时逐字符异或累加。 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function sha256Hex(value: string): string {
  return toHex(sha256(new TextEncoder().encode(value)));
}

export function generateRelayToken(): string {
  return encodeBase64url(randomBytes(RELAY_TOKEN_BYTES));
}

export function generateRelayAdminToken(): string {
  return encodeBase64url(randomBytes(RELAY_ADMIN_TOKEN_BYTES));
}

export function generateRelayTenantId(): string {
  return toHex(randomBytes(RELAY_TENANT_ID_BYTES));
}

export { toHex as relayToHex, fromHex as relayFromHex };
