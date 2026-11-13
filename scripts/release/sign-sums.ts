// 发行包签名：给 SHA256SUMS 产出分离签名 `SHA256SUMS.sig`。
// 只用 Bun 内置 WebCrypto Ed25519，签名 job 不必 bun install。
//
// 用法：
//   VIBETERM_RELEASE_SIGNING_KEY=<base64 32 字节种子> bun scripts/release/sign-sums.ts packages/app/SHA256SUMS

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SECRET_ENV = 'VIBETERM_RELEASE_SIGNING_KEY';
const LEGACY_SECRET_ENV = 'TMEX_RELEASE_SIGNING_KEY';
export const RELEASE_SIG_PREFIX = 'tmex-release-sig';
export const RELEASE_SIG_VERSION = 'v1';
export const RELEASE_SIG_FILE_NAME = 'SHA256SUMS.sig';

export type ReleaseSigningKey = { id: string; publicKey: string };

const PKCS8_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x04,
  0x22,
  0x04,
  0x20
);

export function die(message: string): never {
  console.error(`[sign-sums] ${message}`);
  process.exit(1);
}

export function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

export function decodeBase64(input: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) throw new Error('invalid base64');
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadEmbeddedSigningKeys(source: string): ReleaseSigningKey[] {
  const keys: ReleaseSigningKey[] = [];
  const re = /\{\s*id:\s*'([^']+)',\s*publicKey:\s*'([A-Za-z0-9+/=]+)'\s*\}/g;
  for (const match of source.matchAll(re)) {
    keys.push({ id: match[1] as string, publicKey: match[2] as string });
  }
  return keys;
}

function messageBytes(sums: string | Uint8Array): Uint8Array {
  return typeof sums === 'string' ? new TextEncoder().encode(sums) : sums;
}

async function importSigningKey(seed: Uint8Array): Promise<CryptoKey> {
  if (seed.byteLength !== 32) throw new Error('release signing seed must be 32 bytes');
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + seed.byteLength);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
}

async function verifyWith(publicKeyB64: string, signature: Uint8Array, message: Uint8Array) {
  let raw: Uint8Array;
  try {
    raw = decodeBase64(publicKeyB64);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
}

export async function signReleaseSumsWebCrypto(
  seed: Uint8Array | string,
  sums: string | Uint8Array,
  keys: readonly ReleaseSigningKey[]
): Promise<string> {
  const secret = typeof seed === 'string' ? decodeBase64(seed.trim()) : seed;
  const key = await importSigningKey(secret);
  const message = messageBytes(sums);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, message));
  for (const entry of keys) {
    if (await verifyWith(entry.publicKey, signature, message)) {
      return `${RELEASE_SIG_PREFIX} ${RELEASE_SIG_VERSION} ${entry.id} ${encodeBase64(signature)}`;
    }
  }
  throw new Error('release signing key is not in RELEASE_SIGNING_KEYS');
}

export async function verifyReleaseSumsWebCrypto(
  sums: string | Uint8Array,
  sigLine: string,
  keys: readonly ReleaseSigningKey[]
): Promise<{ ok: true; keyId: string } | { ok: false; keyId: string | null; reason: string }> {
  const parts = sigLine.trim().split(/\s+/);
  if (parts.length !== 4 || parts[0] !== RELEASE_SIG_PREFIX || parts[1] !== RELEASE_SIG_VERSION) {
    return { ok: false, keyId: null, reason: 'malformed' };
  }
  const keyId = parts[2] as string;
  let signature: Uint8Array;
  try {
    signature = decodeBase64(parts[3] as string);
  } catch {
    return { ok: false, keyId, reason: 'malformed' };
  }
  if (signature.byteLength !== 64) return { ok: false, keyId, reason: 'malformed' };
  const entry = keys.find((item) => item.id === keyId);
  if (!entry) return { ok: false, keyId, reason: 'unknown_key' };
  const ok = await verifyWith(entry.publicKey, signature, messageBytes(sums));
  return ok ? { ok: true, keyId } : { ok: false, keyId, reason: 'bad_signature' };
}

export async function signSumsFile(
  sumsPath: string,
  seed: string,
  keys: readonly ReleaseSigningKey[]
): Promise<{ sigPath: string; keyId: string }> {
  if (!seed.trim()) die(`${SECRET_ENV} is not set; refusing to publish an unsigned release.`);
  let sums: Buffer;
  try {
    sums = readFileSync(sumsPath);
  } catch (error) {
    die(`cannot read ${sumsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sums.byteLength === 0) die(`${sumsPath} is empty`);
  let sigLine: string;
  try {
    sigLine = await signReleaseSumsWebCrypto(seed, new Uint8Array(sums), keys);
  } catch (error) {
    die(`signing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const verified = await verifyReleaseSumsWebCrypto(new Uint8Array(sums), sigLine, keys);
  if (!verified.ok) die(`self-verification failed (${verified.reason})`);
  const sigPath = sumsPath.replace(/SHA256SUMS$/, RELEASE_SIG_FILE_NAME);
  if (sigPath === sumsPath) die(`${sumsPath} does not end with SHA256SUMS`);
  writeFileSync(sigPath, `${sigLine}\n`, { mode: 0o644 });
  return { sigPath, keyId: verified.keyId };
}

async function main(): Promise<void> {
  const sumsPath = resolve(process.argv[2] ?? 'packages/app/SHA256SUMS');
  const seed = (process.env[SECRET_ENV] ?? process.env[LEGACY_SECRET_ENV] ?? '').trim();
  const keysPath = resolve(import.meta.dir, '../../packages/shared/src/release/release-signing.ts');
  let keysSource: string;
  try {
    keysSource = readFileSync(keysPath, 'utf8');
  } catch (error) {
    die(`cannot read ${keysPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const keys = loadEmbeddedSigningKeys(keysSource);
  if (keys.length === 0) die(`no RELEASE_SIGNING_KEYS found in ${keysPath}`);
  const { sigPath, keyId } = await signSumsFile(sumsPath, seed, keys);
  console.log(`[sign-sums] signed ${sumsPath} with key ${keyId} -> ${sigPath}`);
}

if (import.meta.main) {
  void main().catch((error) => {
    die(error instanceof Error ? error.message : String(error));
  });
}
