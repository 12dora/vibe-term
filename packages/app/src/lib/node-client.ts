import {
  LEGACY_NODE_SESSION_COOKIE_PREFIX,
  NODE_SESSION_COOKIE_PREFIX,
} from '../../../../apps/gateway/src/auth/cookies';
import {
  type RootKey,
  buildLogin,
  createDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeDelegation,
  encodeLogin,
  generateEd25519KeyPair,
  signLogin,
} from '../../../shared/src/auth';
import { SET_SESSION_HEADER, readHeaderPair } from '../../../shared/src/http/mesh-headers';
import { t } from '../i18n';
import type { FetchLike } from './fetch-like';

export type SecondFactorPolicy = 'either' | 'totp' | 'passkey' | 'none';

export type NodeAuthMode = {
  mode: string;
  nodeId: string | null;
  uid: string | null;
  username: string | null;
  totpEnabled: boolean;
  passkeySecondFactor: boolean;
  secondFactorPolicy: SecondFactorPolicy | null;
  kdfParams: {
    salt: string;
    memory_kib: number;
    iterations: number;
    parallelism: number;
  } | null;
  caFingerprint: string | null;
};

export function parseSecondFactorPolicy(value: unknown): SecondFactorPolicy | null {
  if (value === 'either' || value === 'totp' || value === 'passkey' || value === 'none') {
    return value;
  }
  return null;
}

/** CLI 做不了 WebAuthn：只在策略是 passkey（旧节点则回退到有钥匙且未开 TOTP）时拒绝口令登录。 */
export function cliPasswordLoginBlockedByPasskey(mode: {
  secondFactorPolicy?: string | null;
  passkeySecondFactor: boolean;
  totpEnabled: boolean;
}): boolean {
  if (mode.secondFactorPolicy === 'passkey') return true;
  if (
    mode.secondFactorPolicy === 'either' ||
    mode.secondFactorPolicy === 'totp' ||
    mode.secondFactorPolicy === 'none'
  ) {
    return false;
  }
  return mode.passkeySecondFactor && !mode.totpEnabled;
}

export type NodeLoginResult = {
  sid: string;
  expiresAt: number;
  cookieHeader: string;
  nodeId: string;
};

export type NodeFetch = FetchLike;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export function withRedirectError(init?: RequestInit): RequestInit {
  return { ...init, redirect: 'error' };
}

export function isNetworkFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith('redeem failed:')) return false;
  if (error.message.startsWith('auth ')) return false;
  if (error.message.startsWith('create enrollment failed:')) return false;
  if (error.message.startsWith('list nodes failed:')) return false;
  return true;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

export async function fetchAuthMode(
  baseUrl: string,
  fetcher: NodeFetch = fetch
): Promise<NodeAuthMode> {
  const response = await fetcher(joinUrl(baseUrl, '/api/auth/mode'), withRedirectError());
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`auth mode failed: HTTP ${response.status}`);
  }
  return {
    mode: typeof body.mode === 'string' ? body.mode : 'none',
    nodeId: typeof body.nodeId === 'string' ? body.nodeId : null,
    uid: typeof body.uid === 'string' ? body.uid : null,
    username: typeof body.username === 'string' ? body.username : null,
    totpEnabled: body.totpEnabled === true,
    passkeySecondFactor: body.passkeySecondFactor === true,
    secondFactorPolicy: parseSecondFactorPolicy(body.secondFactorPolicy),
    kdfParams:
      body.kdfParams && typeof body.kdfParams === 'object'
        ? (body.kdfParams as NodeAuthMode['kdfParams'])
        : null,
    caFingerprint: typeof body.caFingerprint === 'string' ? body.caFingerprint : null,
  };
}

export async function loginWithRootKey(options: {
  baseUrl: string;
  rootKey: RootKey;
  uid: string;
  fetcher?: NodeFetch;
  totp?: { code: string; kTotp: Uint8Array };
}): Promise<NodeLoginResult> {
  const fetcher = options.fetcher ?? fetch;
  const mode = await fetchAuthMode(options.baseUrl, fetcher);
  const uid = options.uid;
  const challengeRes = await fetcher(
    joinUrl(options.baseUrl, '/api/auth/challenge'),
    withRedirectError({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid }),
    })
  );
  const challengeBody = await readJson(challengeRes);
  if (!challengeRes.ok) {
    throw new Error(
      `auth challenge failed: HTTP ${challengeRes.status} ${String(challengeBody.error ?? challengeBody.code ?? '')}`
    );
  }
  const challengeId = String(challengeBody.challenge_id ?? '');
  const nonce = decodeBase64url(String(challengeBody.nonce ?? ''));
  const nodePk = decodeBase64url(String(challengeBody.nodePk ?? ''));
  const nodeId = mode.nodeId || 'self';
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const signed = createDelegation(options.rootKey, {
    uid,
    sessPk: sess.publicKey,
    now,
  });
  const login = buildLogin({
    challengeId,
    nonce,
    target: nodeId,
    targetPk: nodePk,
    uid,
    entry: 'self',
  });
  const sig = signLogin(sess.secretKey, login);
  const loginPayload: Record<string, unknown> = {
    login: encodeBase64url(encodeLogin(login)),
    sig: encodeBase64url(sig),
    delegation: encodeBase64url(encodeDelegation(signed.delegation)),
    delegation_sig: encodeBase64url(signed.sig),
  };
  if (options.totp) {
    loginPayload.totp = {
      code: options.totp.code,
      k_totp: encodeBase64url(options.totp.kTotp),
    };
  }
  const loginRes = await fetcher(
    joinUrl(options.baseUrl, '/api/auth/login'),
    withRedirectError({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loginPayload),
    })
  );
  const loginBody = await readJson(loginRes);
  if (!loginRes.ok) {
    throw authLoginError(loginRes.status, loginBody);
  }
  const sid = sessionIdFromLoginResponse(loginRes, nodeId);
  if (!sid) {
    throw new Error('auth login did not return sid');
  }
  const cookieHeader = cookieHeaderForSession(sid, nodeId);
  return {
    sid,
    expiresAt: typeof loginBody.expires_at === 'number' ? loginBody.expires_at : 0,
    cookieHeader,
    nodeId,
  };
}

const AUTH_LOGIN_ERROR_BY_CODE: Record<string, string> = {
  PASSKEY_REQUIRED: 'cli.passkey.loginUnavailable',
  PASSKEY_INVALID: 'Passkey second-factor verification failed.',
  INVALID_CREDENTIALS: 'Invalid credentials.',
  TOTP_REQUIRED: 'TOTP code is required.',
  TOTP_INVALID: 'TOTP code is invalid.',
};

function authLoginError(status: number, body: Record<string, unknown>): Error {
  const code = String(body.error ?? body.code ?? '');
  const mapped = AUTH_LOGIN_ERROR_BY_CODE[code];
  if (!mapped) return new Error(`auth login failed: HTTP ${status} ${code}`);
  return new Error(mapped.startsWith('cli.') ? t(mapped) : mapped);
}

/** 会话 cookie 前缀：新名在前，旧名供混合版本期的老节点使用。 */
const SESSION_COOKIE_PREFIXES = [
  NODE_SESSION_COOKIE_PREFIX,
  LEGACY_NODE_SESSION_COOKIE_PREFIX,
] as const;

/** 请求侧两个前缀都带：对端是 ≥2.0 还是 1.1.x 都能认出会话。 */
export function cookieHeaderForSession(sid: string, nodeId: string): string {
  const names = SESSION_COOKIE_PREFIXES.flatMap((prefix) =>
    !nodeId || nodeId === 'self' ? [`${prefix}self`] : [`${prefix}self`, `${prefix}${nodeId}`]
  );
  return names.map((name) => `${name}=${sid}`).join('; ');
}

export function sessionIdFromLoginResponse(response: Response, nodeId: string): string {
  const fromHeader = sessionIdFromSetSessionHeader(
    readHeaderPair(response.headers, SET_SESSION_HEADER)
  );
  if (fromHeader) return fromHeader;

  const cookies = collectSetCookies(response);
  for (const prefix of SESSION_COOKIE_PREFIXES) {
    const selfCookie = cookies.get(`${prefix}self`);
    if (selfCookie) return selfCookie;
    if (nodeId) {
      const named = cookies.get(`${prefix}${nodeId}`);
      if (named) return named;
    }
  }
  for (const [name, value] of cookies) {
    if (SESSION_COOKIE_PREFIXES.some((prefix) => name.startsWith(prefix)) && value) return value;
  }
  return '';
}

function sessionIdFromSetSessionHeader(value: string | null): string {
  if (!value) return '';
  const split = value.indexOf(';');
  const sid = (split === -1 ? value : value.slice(0, split)).trim();
  return sid;
}

function collectSetCookies(response: Response): Map<string, string> {
  const lines: string[] = [];
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') {
    lines.push(...headers.getSetCookie());
  } else {
    const single = response.headers.get('set-cookie');
    if (single) lines.push(single);
  }
  const cookies = new Map<string, string>();
  for (const line of lines) {
    const firstPair = line.split(';')[0] ?? '';
    const separator = firstPair.indexOf('=');
    if (separator === -1) continue;
    const name = firstPair.slice(0, separator).trim();
    const value = firstPair.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}
