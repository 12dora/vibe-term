// 发行包签名：SHA256SUMS 的 Ed25519 分离签名，公钥内嵌在代码里。
//
// 威胁模型：入口 / hub 被攻陷后可以给节点推任意 tarball，而节点只会拿推送方自报的 sha256
// 去比对——攻击者当然会给出自己那份坏包的 sha256。签名把「谁说的」变成「谁签的」：
// 只有持有发布私钥的流水线能产出可验的 SHA256SUMS，节点离线也能独立判定。
//
// 浏览器安全：只用 `@noble/curves` 与 btoa/atob，不碰 node: 模块，可从主入口导出。

import { ed25519 } from '@noble/curves/ed25519.js';
import { compareSemver } from '../semver';
import { releaseTarballName } from './source';

/** 签名行的固定前缀与格式版本。整行形如 `tmex-release-sig v1 <keyId> <base64 sig>`。 */
export const RELEASE_SIG_PREFIX = 'tmex-release-sig';
export const RELEASE_SIG_VERSION = 'v1';

/** 发行包签名文件名（与 SHA256SUMS 同目录同 tag）。 */
export const RELEASE_SIG_FILE_NAME = 'SHA256SUMS.sig';

export type ReleaseSigningKey = {
  /** 短标识，出现在签名行里，用来在多把钥并存时选中一把。 */
  id: string;
  /** raw 32 字节 Ed25519 公钥的标准 base64。 */
  publicKey: string;
};

/**
 * 内嵌的发布公钥。轮换只做「追加」：新钥追加到数组末尾并用它签新版本，旧钥保留，
 * 老版本的 SHA256SUMS 才继续可验。只有确认不再需要验证某把钥签过的任何版本时才移除。
 */
export const RELEASE_SIGNING_KEYS: readonly ReleaseSigningKey[] = [
  { id: 'r1', publicKey: 'x3aihYJPAJ6OafKJ/W5QHGX1IA4n61WD650sQaMl3OY=' },
];

/** 从这个版本起发行包必须带签名；更早的版本允许缺签名（老 release 没有 .sig 资产）。 */
export const RELEASE_SIGNING_SINCE = '1.1.39';

/** 该版本是否强制要求签名。版本号解析不了时按「要求」处理（fail-closed）。 */
export function releaseSignatureRequired(version: string): boolean {
  const cmp = compareSemver(version, RELEASE_SIGNING_SINCE);
  return cmp === null ? true : cmp >= 0;
}

export type ReleaseSumsVerification =
  | { ok: true; keyId: string }
  | { ok: false; keyId: string | null; reason: 'malformed' | 'unknown_key' | 'bad_signature' };

function encodeBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

function decodeBase64(input: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) throw new Error('invalid base64');
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function messageBytes(sums: string | Uint8Array): Uint8Array {
  return typeof sums === 'string' ? new TextEncoder().encode(sums) : sums;
}

/** 签名行的最后一段：base64 的 64 字节签名。解析失败返回 null。 */
function decodeSignature(raw: string): Uint8Array | null {
  try {
    const bytes = decodeBase64(raw);
    return bytes.byteLength === 64 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * 用发布私钥种子（raw 32 字节，或其标准 base64）对 SHA256SUMS 原始字节签名，返回整条签名行。
 * 种子对应的公钥必须已经在 `keys`（缺省为内嵌钥表）里，否则抛错——避免签出一把谁也验不了的钥。
 */
export function signReleaseSums(
  seed: Uint8Array | string,
  sums: string | Uint8Array,
  keys: readonly ReleaseSigningKey[] = RELEASE_SIGNING_KEYS
): string {
  const secret = typeof seed === 'string' ? decodeBase64(seed.trim()) : seed;
  if (secret.byteLength !== 32) throw new Error('release signing seed must be 32 bytes');
  const encodedPublicKey = encodeBase64(ed25519.getPublicKey(secret));
  const key = keys.find((entry) => entry.publicKey === encodedPublicKey);
  if (!key) {
    throw new Error(`release signing key ${encodedPublicKey} is not in RELEASE_SIGNING_KEYS`);
  }
  const signature = ed25519.sign(messageBytes(sums), secret);
  return `${RELEASE_SIG_PREFIX} ${RELEASE_SIG_VERSION} ${key.id} ${encodeBase64(signature)}`;
}

/** 验签：`sums` 必须是 SHA256SUMS 的原样字节（含末尾换行），任何改动都会验不过。 */
export function verifyReleaseSums(
  sums: string | Uint8Array,
  sigLine: string,
  keys: readonly ReleaseSigningKey[] = RELEASE_SIGNING_KEYS
): ReleaseSumsVerification {
  const parts = typeof sigLine === 'string' ? sigLine.trim().split(/\s+/) : [];
  if (parts.length !== 4 || parts[0] !== RELEASE_SIG_PREFIX || parts[1] !== RELEASE_SIG_VERSION) {
    return { ok: false, keyId: null, reason: 'malformed' };
  }
  const keyId = parts[2] as string;
  const signature = decodeSignature(parts[3] as string);
  if (!signature) return { ok: false, keyId, reason: 'malformed' };
  const key = keys.find((entry) => entry.id === keyId);
  if (!key) return { ok: false, keyId, reason: 'unknown_key' };
  let publicKey: Uint8Array;
  try {
    publicKey = decodeBase64(key.publicKey);
  } catch {
    return { ok: false, keyId, reason: 'unknown_key' };
  }
  const verified = (() => {
    try {
      return ed25519.verify(signature, messageBytes(sums), publicKey, { zip215: false });
    } catch {
      return false;
    }
  })();
  return verified ? { ok: true, keyId } : { ok: false, keyId, reason: 'bad_signature' };
}

const SUM_LINE = /^([a-fA-F0-9]{64})\s+\*?(\S+)$/;

/**
 * 只取路径最后一段：shasum 有时带目录前缀，比对时统一按文件名。
 * 解析与查询共用这一个实现——CLI 与网关一旦各用一套 basename，同一份 SHA256SUMS 会给出不同结论。
 */
export function releaseSumsFileName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** 解析 SHA256SUMS 为「文件名 → 小写摘要」。重复文件名以首次出现为准，非法行跳过。 */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const matched = SUM_LINE.exec(raw.trim());
    if (!matched) continue;
    const name = releaseSumsFileName(matched[2] as string);
    if (out.has(name)) continue;
    out.set(name, (matched[1] as string).toLowerCase());
  }
  return out;
}

/** SHA256SUMS 里 `tmex-cli-<version>.tgz` 的摘要；没有该条目返回 null。 */
export function expectedTarballHash(sumsText: string, version: string): string | null {
  return parseSha256Sums(sumsText).get(releaseTarballName(version)) ?? null;
}
