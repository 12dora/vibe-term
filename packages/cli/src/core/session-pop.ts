// CLI 会话持有证明：用登录时的 sessSk 为每个 HTTP/WS 请求签短时 proof。
// Node ≥ 20 走 noble（`signEd25519` / `signPop`），不用 Node WebCrypto Ed25519。

import {
  buildPopMessage,
  decodeBase64url,
  encodeBase64url,
  formatPopProof,
  popTargetFromUrl,
  randomBytes,
  signEd25519,
  signPop,
} from '@vibeterm/shared/auth';
import { POP_HEADER } from '@vibeterm/shared/http/mesh-headers';
import { AuthError } from './errors';

export const POP_REQUIRED = 'POP_REQUIRED';
export const POP_INVALID = 'POP_INVALID';

export const POP_ERROR_MESSAGE_EN = 'Session key missing or invalid. Run `vibeterm login` again.';
export const POP_ERROR_MESSAGE_ZH = '会话密钥缺失或无效，请重新执行 vibeterm login。';

/** noble `keygen()` 是 32 字节种子；部分测试夹具仍用 tweetnacl 的 64 字节 secretKey。 */
const SESS_SK_BYTES = new Set([32, 64]);
const SESS_PK_BYTES = 32;
/** 与 `packages/shared/src/auth/session-pop.ts` 的 `POP_NONCE_BYTES` 一致（12 → b64url 16）。 */
const POP_NONCE_BYTES = 12;

export interface PopKeyPair {
  sessSk: Uint8Array;
  sessPk: Uint8Array;
}

export function isPopErrorCode(code: string | null | undefined): boolean {
  return code === POP_REQUIRED || code === POP_INVALID;
}

/** 远程 job 失败串：`auth: POP_REQUIRED` 等；裸 POP_* 码同样视为需要重新登录。 */
export function isPopAuthJobError(text: string | null | undefined): boolean {
  if (!text) return false;
  return isPopErrorCode(text) || text.startsWith('auth:');
}

/** 拷贝会话密钥，避免 destroy()/fill(0) 清掉仍被 store 引用的字节。不要用 Uint8Array.from。 */
export function copyPopKey(key: PopKeyPair): PopKeyPair {
  return { sessSk: new Uint8Array(key.sessSk), sessPk: new Uint8Array(key.sessPk) };
}

export function parsePopKey(
  sessSk: string | null | undefined,
  sessPk: string | null | undefined
): PopKeyPair | null {
  if (!sessSk || !sessPk) return null;
  try {
    const sk = decodeKey(sessSk, SESS_SK_BYTES);
    const pk = decodeSized(sessPk, SESS_PK_BYTES);
    if (!sk || !pk) return null;
    return { sessSk: sk, sessPk: pk };
  } catch {
    return null;
  }
}

function decodeSized(value: string, size: number): Uint8Array | null {
  const bytes = decodeBase64url(value);
  return bytes.length === size ? bytes : null;
}

function decodeKey(value: string, allowed: Set<number>): Uint8Array | null {
  const bytes = decodeBase64url(value);
  return allowed.has(bytes.length) ? bytes : null;
}

export function encodePopKey(key: PopKeyPair): { sessSk: string; sessPk: string } {
  return { sessSk: encodeBase64url(key.sessSk), sessPk: encodeBase64url(key.sessPk) };
}

export function cookieCarriesSession(cookie: string): boolean {
  return /(?:^|;\s*)(?:vibeterm_s_|tmex_s_)/.test(cookie);
}

function canSign(cookie: string, key: PopKeyPair | null): key is PopKeyPair {
  return Boolean(key && cookie && cookieCarriesSession(cookie));
}

/** HTTP 路径：每次尝试都走共享 `signPop`（新 ts + nonce）。 */
export function signSessionPop(sessSk: Uint8Array, method: string, url: string): Promise<string> {
  return signPop((message) => signEd25519(sessSk, message), popTargetFromUrl(method, url));
}

/**
 * WS 握手头必须同步给出（`ws` SocketFactory 是同步的）。
 * 证明格式与 `signPop` 相同，签名仍走 noble `signEd25519`。
 */
export function signSessionPopSync(sessSk: Uint8Array, method: string, url: string): string {
  const target = popTargetFromUrl(method, url);
  const ts = Math.floor(Date.now());
  const nonce = encodeBase64url(randomBytes(POP_NONCE_BYTES));
  const sig = signEd25519(sessSk, buildPopMessage(target, ts, nonce));
  return formatPopProof({ ts, nonce, sig });
}

export async function stampPopHeader(
  headers: Headers,
  method: string,
  url: string,
  cookie: string,
  key: PopKeyPair | null
): Promise<boolean> {
  if (!canSign(cookie, key)) return false;
  headers.set(POP_HEADER, await signSessionPop(key.sessSk, method, url));
  return true;
}

export function stampPopRecord(
  headers: Record<string, string>,
  method: string,
  url: string,
  cookie: string,
  key: PopKeyPair | null
): boolean {
  if (!canSign(cookie, key)) return false;
  headers[POP_HEADER] = signSessionPopSync(key.sessSk, method, url);
  return true;
}

export function isReplayableBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  );
}

export async function isPopUnauthorizedResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = (await response.clone().text()).slice(0, 2048).trim();
    return isPopErrorCode(codeFromBody(body));
  } catch {
    return false;
  }
}

export function codeFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: unknown };
    if (typeof parsed.code === 'string') return parsed.code;
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    // 非 JSON
  }
  return null;
}

/** WS 关闭 reason 是裸码；本地 exec 升级失败则是 HTTP 401 JSON。 */
export function popCodeFromMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (isPopErrorCode(trimmed)) return trimmed;
  const fromBody = codeFromBody(trimmed);
  return isPopErrorCode(fromBody) ? fromBody : null;
}

function cliLangZh(): boolean {
  const raw = process.env.VIBETERM_CLI_LANG || process.env.LANG || '';
  const lower = raw.trim().toLowerCase().replaceAll('_', '-');
  return lower === 'zh' || lower === 'cn' || lower.startsWith('zh-cn');
}

export function popErrorMessage(): string {
  return cliLangZh() ? POP_ERROR_MESSAGE_ZH : POP_ERROR_MESSAGE_EN;
}

export function popNodeErrorMessage(nodeName: string): string {
  return `${nodeName}: ${popErrorMessage()}`;
}

export function popAuthError(code?: string, nodeName?: string): AuthError {
  const message = nodeName ? popNodeErrorMessage(nodeName) : popErrorMessage();
  return new AuthError(message, 'run: vibeterm login', code);
}

export function popNodeAuthError(nodeName: string, code?: string): AuthError {
  return popAuthError(code, nodeName);
}

export function remapPopNodeError(error: unknown, nodeName: string): never {
  if (error instanceof AuthError && isPopErrorCode(error.code)) {
    throw popNodeAuthError(nodeName, error.code);
  }
  throw error;
}
