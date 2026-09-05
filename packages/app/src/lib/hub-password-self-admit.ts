import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { buildSelfAdmitRecord } from '../../../../apps/gateway/src/auth/user-key-self-admit';
import type { UserKeyService } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  type RootKey,
  type UserKeyState,
  decodeBase64url,
  deriveTotpKey,
  encodeBase64url,
} from '../../../shared/src/auth';
import { JoinError } from '../commands/hub';
import { errorMessage } from './error-message';
import {
  type HubFetch,
  type HubLoginResult,
  fetchAuthMode,
  isNetworkFetchError,
  loginWithRootKey,
} from './hub-client';
import type { LocalAuthContext } from './local-auth';

export const HUB_JOIN_ADMIT_ATTEMPTS = 4;

const KEY_LOG_CONFLICT_CODES = new Set([
  'KEY_LOG_FORK',
  'seq_gap',
  'prev_hash_mismatch',
  'epoch_mismatch',
  'fork',
]);

export type PublishHubJoinSelfAdmitInput = {
  auth: LocalAuthContext;
  hubUrl: string;
  userId: string;
  rootKey: RootKey;
  fetcher?: HubFetch;
  now?: () => number;
  totpCode?: string;
};

export type PublishHubJoinSelfAdmitResult = {
  appended: boolean;
  admitPending: boolean;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function withCookie(fetcher: HubFetch, cookie: string): HubFetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('cookie')) headers.set('cookie', cookie);
    return fetcher(input, { ...init, headers });
  };
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

function errorCode(body: Record<string, unknown>): string {
  if (typeof body.code === 'string' && body.code) return body.code;
  const error = body.error;
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string' && code) return code;
  }
  return '';
}

function asJoinError(error: unknown, fallback: string): JoinError {
  if (error instanceof JoinError) return error;
  const message = error instanceof Error ? error.message : fallback;
  if (message.includes('TOTP_REQUIRED') || /TOTP code is required/i.test(message)) {
    return new JoinError('totp_required', message);
  }
  if (message.includes('TOTP_INVALID') || /TOTP code is invalid/i.test(message)) {
    return new JoinError('totp_invalid', message);
  }
  if (isNetworkFetchError(error)) return new JoinError('hub_unreachable', message);
  return new JoinError('join_failed', message);
}

function isPasskeyRequiredError(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes('PASSKEY_REQUIRED') || /requires passkey second-factor/i.test(message);
}

function stubHeadService(state: UserKeyState, head: UserKeyState['head'], rootEpoch: number) {
  return {
    currentState: () => ({ ...state, head, rootEpoch }),
  } as unknown as UserKeyService;
}

function parseHead(body: Record<string, unknown>): {
  seq: bigint;
  hash: Uint8Array;
  rootEpoch: number;
} {
  const seqRaw = body.seq;
  const seq =
    typeof seqRaw === 'bigint'
      ? seqRaw
      : BigInt(typeof seqRaw === 'number' || typeof seqRaw === 'string' ? seqRaw : 0);
  if (typeof body.hash !== 'string') {
    throw new JoinError('join_failed', 'hub key-log head is missing hash');
  }
  const rootEpoch =
    typeof body.rootEpoch === 'number' && Number.isFinite(body.rootEpoch) ? body.rootEpoch : 0;
  return { seq, hash: decodeBase64url(body.hash), rootEpoch };
}

async function fetchHubKeyLogHead(
  fetcher: HubFetch,
  hubUrl: string
): Promise<{ seq: bigint; hash: Uint8Array; rootEpoch: number }> {
  let response: Response;
  try {
    response = await fetcher(joinUrl(hubUrl, '/api/auth/keylog/head'), { redirect: 'error' });
  } catch (error) {
    throw asJoinError(error, 'unable to read hub key-log head');
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new JoinError(
      response.status >= 500 ? 'hub_unreachable' : 'join_failed',
      `key-log head failed: HTTP ${response.status} ${errorCode(body) || ''}`.trim()
    );
  }
  return parseHead(body);
}

async function postHubAdmit(
  fetcher: HubFetch,
  hubUrl: string,
  record: { bytes: Uint8Array; sig: Uint8Array }
): Promise<{ ok: true } | { ok: false; conflict: boolean; message: string }> {
  let response: Response;
  try {
    response = await fetcher(joinUrl(hubUrl, '/api/auth/keylog'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        bytes: encodeBase64url(record.bytes),
        sig: encodeBase64url(record.sig),
      }),
    });
  } catch (error) {
    throw asJoinError(error, 'unable to publish admit-node to hub');
  }
  const body = await readJson(response);
  if (response.ok) return { ok: true };
  const code = errorCode(body);
  const message = `admit-node append failed: HTTP ${response.status} ${code}`.trim();
  return { ok: false, conflict: KEY_LOG_CONFLICT_CODES.has(code), message };
}

function alreadyAdmitted(state: UserKeyState, nodeIdHex: string): boolean {
  const cert = state.nodeCerts.get(nodeIdHex);
  return Boolean(cert && !cert.revoked);
}

const LOCAL_ADMIT_IGNORABLE = new Set(['seq_gap', 'prev_hash_mismatch', 'fork']);

function totpForJoinLogin(
  input: PublishHubJoinSelfAdmitInput,
  state: UserKeyState
): { code: string; kTotp: Uint8Array } {
  const code = input.totpCode?.trim() ?? '';
  if (!code) {
    throw new JoinError('totp_required', 'TOTP code is required');
  }
  const user = input.auth.userStore.getById(input.userId);
  const rootEpoch = user?.rootEpoch ?? state.rootEpoch;
  return { code, kTotp: deriveTotpKey(input.rootKey.seed, input.userId, rootEpoch) };
}

async function openJoinAdmitSession(
  input: PublishHubJoinSelfAdmitInput,
  fetcher: HubFetch,
  state: UserKeyState
): Promise<{ kind: 'pending' } | { kind: 'session'; session: HubLoginResult }> {
  let mode: Awaited<ReturnType<typeof fetchAuthMode>>;
  try {
    mode = await fetchAuthMode(input.hubUrl, fetcher);
  } catch (error) {
    throw asJoinError(error, 'unable to resolve hub auth mode');
  }
  if (mode.passkeySecondFactor) {
    return { kind: 'pending' };
  }
  const totp = mode.totpEnabled ? totpForJoinLogin(input, state) : undefined;
  try {
    const session = await loginWithRootKey({
      baseUrl: input.hubUrl,
      rootKey: input.rootKey,
      uid: input.userId,
      fetcher,
      totp,
    });
    return { kind: 'session', session };
  } catch (error) {
    if (isPasskeyRequiredError(error)) return { kind: 'pending' };
    throw asJoinError(error, 'unable to open a hub session to publish admit-node');
  } finally {
    totp?.kTotp.fill(0);
  }
}

async function applyPostedAdmitLocally(
  auth: LocalAuthContext,
  userId: string,
  admit: { bytes: Uint8Array; sig: Uint8Array }
): Promise<void> {
  const applied = await auth.userKeys.apply(userId, admit);
  if (applied.ok || LOCAL_ADMIT_IGNORABLE.has(applied.error)) return;
  throw new JoinError('join_failed', `local admit-node apply failed: ${applied.error}`);
}

/**
 * 口令加入后本机已 commit 密钥日志，但 Hub 的 `node_certs` 还没有这台机器：
 * 用根钥登录 Hub，在其链头上签 `admit-node` 并 POST `/api/auth/keylog`（CAS 冲突则重读重试）。
 * 记录必须在进程重启前到达 Hub——uplink 认证读 `node_certs`，先于任何 key-log catch-up。
 * passkey / TOTP+passkey 账号无法在 CLI 完成登录，跳过自承认并返回 `admitPending`。
 */
export async function publishHubJoinSelfAdmit(
  input: PublishHubJoinSelfAdmitInput
): Promise<PublishHubJoinSelfAdmitResult> {
  const identity = await ensureNodeIdentity(input.auth.identityStore);
  let state: UserKeyState;
  try {
    state = input.auth.userKeys.currentState(input.userId);
  } catch (error) {
    throw asJoinError(error, 'local key state missing after hub join');
  }
  if (alreadyAdmitted(state, identity.nodeIdHex)) {
    return { appended: false, admitPending: false };
  }
  const fetcher = input.fetcher ?? fetch;
  const opened = await openJoinAdmitSession(input, fetcher, state);
  if (opened.kind === 'pending') {
    return { appended: false, admitPending: true };
  }
  const authed = withCookie(fetcher, opened.session.cookieHeader);
  const now = input.now?.() ?? Date.now();
  let lastMessage = 'admit-node append failed';
  for (let attempt = 0; attempt < HUB_JOIN_ADMIT_ATTEMPTS; attempt++) {
    const head = await fetchHubKeyLogHead(authed, input.hubUrl);
    const admit = await buildSelfAdmitRecord({
      service: stubHeadService(state, { seq: head.seq, hash: head.hash }, head.rootEpoch),
      userId: input.userId,
      identity,
      rootKey: input.rootKey,
      now,
    });
    const posted = await postHubAdmit(authed, input.hubUrl, admit);
    if (posted.ok) {
      await applyPostedAdmitLocally(input.auth, input.userId, admit);
      return { appended: true, admitPending: false };
    }
    lastMessage = posted.message;
    if (!posted.conflict || attempt + 1 >= HUB_JOIN_ADMIT_ATTEMPTS) {
      throw new JoinError('join_failed', lastMessage);
    }
    try {
      state = input.auth.userKeys.currentState(input.userId);
    } catch {
      // 冲突重试用 Hub 链头签名，本机状态只影响 alreadyAdmitted
    }
  }
  throw new JoinError('join_failed', lastMessage);
}
