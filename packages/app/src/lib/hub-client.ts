import {
  LEGACY_NODE_SESSION_COOKIE_PREFIX,
  NODE_SESSION_COOKIE_PREFIX,
} from '../../../../apps/gateway/src/auth/cookies';
import {
  type RootKey,
  buildLogin,
  canonicalHubUrl,
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

export type HubAuthMode = {
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

export type HubLoginResult = {
  sid: string;
  expiresAt: number;
  cookieHeader: string;
  nodeId: string;
};

export type RedeemResponse = {
  user: {
    id: string;
    username: string;
    root_public_key: string;
    root_epoch: number;
    kdf_params: unknown;
  };
  user_key_log: Array<{ seq: number | string; bytes: string; sig: string }>;
  node_certs: Array<{
    node_id: string;
    user_id: string;
    admit_record_seq: number;
    certificate: string;
    cert_sig: string;
    authorization: string;
    authorization_sig: string;
    revoked_log_seq: number | null;
  }>;
};

export type HubFetch = FetchLike;

export type HubTrustLookup = {
  get(hubUrl: string): { caPem: string } | null;
};

export function createHubFetcher(
  hubTrustStore: HubTrustLookup,
  hubUrl: string,
  inner: HubFetch = fetch
): HubFetch {
  let key = hubUrl;
  try {
    key = canonicalHubUrl(hubUrl);
  } catch {
    return inner;
  }
  const trusted = hubTrustStore.get(key);
  if (!trusted?.caPem) return inner;
  const ca = [trusted.caPem];
  const pinned: HubFetch = (input, init) => inner(input, { ...init, tls: { ca } });
  return pinned;
}

export type HubNodeListItem = {
  id: string;
  name?: string;
  certificate?: string;
  cert_sig?: string;
  enrollment_token_id?: string;
};

export const REDEEM_NETWORK_RETRY_LIMIT = 3;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function withRedirectError(init?: RequestInit): RequestInit {
  return { ...init, redirect: 'error' };
}

export function assertHubJoinUrl(
  raw: string,
  insecureLocal = false,
  nodeEnv = process.env.NODE_ENV
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid hub url: ${raw}`);
  }
  if (url.protocol === 'https:') {
    return new URL(canonicalHubUrl(url.toString()));
  }
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol === 'http:' && insecureLocal && localHost) {
    if (nodeEnv === 'production') {
      throw new Error('--insecure-local is not allowed when NODE_ENV=production');
    }
    return new URL(canonicalHubUrl(url.toString()));
  }
  throw new Error(
    'hub join requires https: (use --insecure-local only for http://127.0.0.1 or http://localhost)'
  );
}

export function isNetworkFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith('redeem failed:')) return false;
  if (error.message.startsWith('auth ')) return false;
  if (error.message.startsWith('create enrollment failed:')) return false;
  if (error.message.startsWith('list nodes failed:')) return false;
  return true;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
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
  fetcher: HubFetch = fetch
): Promise<HubAuthMode> {
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
        ? (body.kdfParams as HubAuthMode['kdfParams'])
        : null,
    caFingerprint: typeof body.caFingerprint === 'string' ? body.caFingerprint : null,
  };
}

export async function loginWithRootKey(options: {
  baseUrl: string;
  rootKey: RootKey;
  uid: string;
  fetcher?: HubFetch;
  totp?: { code: string; kTotp: Uint8Array };
}): Promise<HubLoginResult> {
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

/** 会话 cookie 前缀：新名在前，旧名供混合版本期的老 hub 使用。 */
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

export async function postEnrollment(options: {
  baseUrl: string;
  cookieHeader: string;
  enrollPk: Uint8Array;
  authorization: Uint8Array;
  authorizationSig: Uint8Array;
  exp: number;
  fetcher?: HubFetch;
}): Promise<{ ok: boolean; id?: string; expires_at?: number }> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    joinUrl(options.baseUrl, '/api/hub/enrollments'),
    withRedirectError({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: options.cookieHeader,
      },
      body: JSON.stringify({
        enroll_pk: encodeBase64url(options.enrollPk),
        authorization: encodeBase64url(options.authorization),
        authorization_sig: encodeBase64url(options.authorizationSig),
        exp: options.exp,
      }),
    })
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `create enrollment failed: HTTP ${response.status} ${String(body.error ?? body.code ?? '')}`
    );
  }
  return {
    ok: true,
    id: typeof body.id === 'string' ? body.id : undefined,
    expires_at: typeof body.expires_at === 'number' ? body.expires_at : undefined,
  };
}

export async function redeemEnrollment(options: {
  baseUrl: string;
  certificate: Uint8Array;
  certSig: Uint8Array;
  name?: string;
  version?: string;
  fetcher?: HubFetch;
}): Promise<RedeemResponse> {
  const fetcher = options.fetcher ?? fetch;
  const init = withRedirectError({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      certificate: encodeBase64url(options.certificate),
      cert_sig: encodeBase64url(options.certSig),
      name: options.name ?? 'node',
      version: options.version ?? '',
    }),
  });
  let lastError: unknown;
  for (let attempt = 1; attempt <= REDEEM_NETWORK_RETRY_LIMIT; attempt++) {
    try {
      const response = await fetcher(joinUrl(options.baseUrl, '/api/hub/enrollments/redeem'), init);
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(
          `redeem failed: HTTP ${response.status} ${String(body.error ?? body.code ?? '')}`
        );
      }
      return body as unknown as RedeemResponse;
    } catch (error) {
      lastError = error;
      if (!isNetworkFetchError(error) || attempt >= REDEEM_NETWORK_RETRY_LIMIT) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function listHubNodes(options: {
  baseUrl: string;
  cookieHeader: string;
  fetcher?: HubFetch;
}): Promise<HubNodeListItem[]> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(
    joinUrl(options.baseUrl, '/api/hub/nodes'),
    withRedirectError({
      headers: { cookie: options.cookieHeader },
    })
  );
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`list nodes failed: HTTP ${response.status}`);
  }
  const nodes = Array.isArray(body.nodes) ? body.nodes : [];
  return nodes.filter((item): item is HubNodeListItem => {
    return Boolean(item) && typeof (item as { id?: unknown }).id === 'string';
  });
}
