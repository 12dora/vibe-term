import { decodeB64url } from './b64url';
import { encodeBase64url, randomBytes } from './encoding';
import { verifyEd25519 } from './root-key';

// 会话持有证明（PoP）：登录时生成的会话密钥 sk_sess 除签 Login 外，还为每个请求签一次短时证明，
// 只偷到 sid（cookie / session.json 里的 sid）而没有私钥时无法使用会话。
export const POP_VERSION = 'v1';
export const POP_QUERY_PARAM = 'pop';
export const POP_MAX_SKEW_MS = 60_000;
const POP_DOMAIN = 'vibeterm/pop/v1';
const POP_NONCE_BYTES = 12;
const POP_SIG_BYTES = 64;
const NODE_PREFIX = /^\/n\/(?:[0-9a-f]{32}|self)(?=\/|$)/;

export type PopSigner = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface PopTarget {
  method: string;
  path: string;
  query: string;
}

export interface PopProof {
  ts: number;
  nonce: string;
  sig: Uint8Array;
}

export type PopVerifyError = 'malformed' | 'expired' | 'bad_signature';
export type PopVerifyResult = { ok: true; proof: PopProof } | { ok: false; error: PopVerifyError };

/** 去掉 `pop` 参数，其余参数保持原始顺序与编码。 */
export function canonicalPopQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw.length === 0) return '';
  return raw
    .split('&')
    .filter((part) => part.length > 0 && part.split('=', 1)[0] !== POP_QUERY_PARAM)
    .join('&');
}

/** 目标节点看到的路径：浏览器侧的 `/n/<nodeId>` / `/n/self` 前缀不参与签名。 */
export function canonicalPopPath(pathname: string): string {
  const stripped = pathname.replace(NODE_PREFIX, '');
  return stripped.length === 0 ? '/' : stripped;
}

export function popTargetFromUrl(method: string, url: string | URL): PopTarget {
  const parsed = typeof url === 'string' ? new URL(url, 'http://pop.invalid') : url;
  return {
    method: method.toUpperCase(),
    path: canonicalPopPath(parsed.pathname),
    query: canonicalPopQuery(parsed.search),
  };
}

export function buildPopMessage(target: PopTarget, ts: number, nonce: string): Uint8Array {
  const text = [
    POP_DOMAIN,
    target.method.toUpperCase(),
    target.path,
    target.query,
    String(ts),
    nonce,
  ].join('\n');
  return new TextEncoder().encode(text);
}

export function formatPopProof(proof: PopProof): string {
  return `${POP_VERSION}.${proof.ts}.${proof.nonce}.${encodeBase64url(proof.sig)}`;
}

export function parsePopProof(value: string | null | undefined): PopProof | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== POP_VERSION) return null;
  const [, tsText, nonce, sigText] = parts as [string, string, string, string];
  if (!/^\d{1,16}$/.test(tsText) || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) return null;
  try {
    return { ts: Number(tsText), nonce, sig: decodeB64url(sigText, POP_SIG_BYTES) };
  } catch {
    return null;
  }
}

export async function signPop(
  signer: PopSigner,
  target: PopTarget,
  now: number = Date.now()
): Promise<string> {
  const ts = Math.floor(now);
  const nonce = encodeBase64url(randomBytes(POP_NONCE_BYTES));
  const sig = await signer(buildPopMessage(target, ts, nonce));
  return formatPopProof({ ts, nonce, sig });
}

export function verifyPop(
  sessPublicKey: Uint8Array,
  value: string | null | undefined,
  target: PopTarget,
  now: number = Date.now(),
  maxSkewMs: number = POP_MAX_SKEW_MS
): PopVerifyResult {
  const proof = parsePopProof(value);
  if (!proof) return { ok: false, error: 'malformed' };
  if (Math.abs(now - proof.ts) > maxSkewMs) return { ok: false, error: 'expired' };
  const message = buildPopMessage(target, proof.ts, proof.nonce);
  if (!verifyEd25519(proof.sig, message, sessPublicKey))
    return { ok: false, error: 'bad_signature' };
  return { ok: true, proof };
}
