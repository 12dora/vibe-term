import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { kdfParamsFromJson } from '../../../../apps/gateway/src/auth/user-key-service';
import { users } from '../../../../apps/gateway/src/db/schema';
import {
  type RootKey,
  buildKeyLogRecord,
  decodeBase64url,
  deriveTotpKey,
  encodeBase64url,
  encodeKeyLogRecord,
  signKeyLogRecordWithRoot,
} from '../../../shared/src/auth';
import {
  type RelayIo,
  asNumber,
  asText,
  gatewayBaseUrl,
  joinRelayUrl,
  requestRelayJson,
} from '../commands/relay-shared';
import type { ParsedArgs } from '../types';
import { fetchAuthMode, loginWithRootKey } from './hub-client';
import type { LocalAuthContext } from './local-auth';
import { assertRootKeyMatches, deriveRootKey, resolvePassword } from './password';
import { promptPassword, promptText } from './prompt';
import { asString } from './validate';

export type RelayStatusRelay = {
  url: string;
  priority: number;
  online: boolean;
  attached: boolean;
  rttMs: number | null;
  lastError: string | null;
  kicked: boolean;
};

export type RelayStatusResponse = {
  mode: 'relay' | 'hub' | 'none';
  tenantId: string | null;
  relays: RelayStatusRelay[];
  metaEpoch: number;
  nodesViaRelay: number;
  reauthRequired: boolean;
  raw: Record<string, unknown>;
};

export type RelayTenantSession = {
  ctx: LocalAuthContext;
  baseUrl: string;
  cookieHeader: string;
  userId: string;
  rootKey: RootKey;
  fetcher?: typeof fetch;
};

const PASSKEY_CLI_UNAVAILABLE =
  'This account requires passkey second-factor for password sign-in, so relay commands are unavailable from the CLI. Use the web UI (Settings → Nodes → relay) instead.';

async function resolveNewUsername(parsed: ParsedArgs): Promise<string> {
  const flag = asString(parsed.flags.username);
  if (flag) return flag;
  const { isInteractiveStdin } = await import('./prompt');
  if (!isInteractiveStdin()) return 'admin';
  const answer = await promptText({ nonInteractive: false }, 'New username', 'admin');
  return answer || 'admin';
}

async function createLocalUser(
  parsed: ParsedArgs,
  ctx: LocalAuthContext,
  io: RelayIo
): Promise<{ userId: string; rootKey: RootKey }> {
  const username = await resolveNewUsername(parsed);
  const password = await resolvePassword({
    password: io.password,
    confirm: io.password === undefined,
    prompt: 'New password',
    confirmPrompt: 'Confirm password',
  });
  const identity = await ensureNodeIdentity(ctx.identityStore);
  const boot = await ctx.userKeys.bootstrapUserWithSelfAdmit({
    username,
    password,
    identity,
    now: io.now?.() ?? Date.now(),
  });
  return { userId: boot.userId, rootKey: boot.rootKey };
}

async function openExistingRootKey(
  ctx: LocalAuthContext,
  io: RelayIo,
  userId: string
): Promise<RootKey> {
  const user = ctx.userStore.getById(userId);
  if (!user) throw new Error('user missing');
  const password = await resolvePassword({
    password: io.password,
    confirm: false,
    prompt: 'Password',
  });
  const rootKey = await deriveRootKey(password, kdfParamsFromJson(user.kdfParamsJson));
  assertRootKeyMatches(rootKey, user.rootPublicKey);
  return rootKey;
}

async function resolveTotp(
  ctx: LocalAuthContext,
  io: RelayIo,
  input: { userId: string; rootKey: RootKey; enabled: boolean }
): Promise<{ code: string; kTotp: Uint8Array } | undefined> {
  if (!input.enabled) return undefined;
  const user = ctx.userStore.getById(input.userId);
  if (!user) throw new Error('user missing');
  const code =
    io.totpCode ?? (await promptPassword('TOTP code', { envKey: 'TMEX_TOTP', confirm: false }));
  if (!code) throw new Error('TOTP code cannot be empty');
  return { code, kTotp: deriveTotpKey(input.rootKey.seed, user.id, user.rootEpoch) };
}

export async function openRelayTenantSession(
  parsed: ParsedArgs,
  ctx: LocalAuthContext,
  io: RelayIo
): Promise<RelayTenantSession> {
  const baseUrl = gatewayBaseUrl(io.env ?? ctx.env ?? process.env);
  const existing = ctx.db.select().from(users).all();
  const first = existing[0];
  const opened = first
    ? { userId: first.id, rootKey: await openExistingRootKey(ctx, io, first.id) }
    : await createLocalUser(parsed, ctx, io);
  const fetcher = io.fetcher;
  const mode = await fetchAuthMode(baseUrl, fetcher ?? fetch);
  if (mode.passkeySecondFactor) {
    throw new Error(PASSKEY_CLI_UNAVAILABLE);
  }
  const totp = await resolveTotp(ctx, io, {
    userId: opened.userId,
    rootKey: opened.rootKey,
    enabled: mode.totpEnabled,
  });
  const session = await loginWithRootKey({
    baseUrl,
    rootKey: opened.rootKey,
    uid: opened.userId,
    fetcher,
    totp,
  });
  totp?.kTotp.fill(0);
  return {
    ctx,
    baseUrl,
    cookieHeader: session.cookieHeader,
    userId: opened.userId,
    rootKey: opened.rootKey,
    fetcher,
  };
}

export function sessionHeaders(session: RelayTenantSession): Record<string, string> {
  return { cookie: session.cookieHeader };
}

export async function relayGatewayRequest(
  session: RelayTenantSession,
  input: { path: string; method?: string; body?: unknown; label: string }
): Promise<Record<string, unknown>> {
  return await requestRelayJson({
    fetcher: session.fetcher,
    url: joinRelayUrl(session.baseUrl, input.path),
    method: input.method,
    headers: sessionHeaders(session),
    body: input.body,
    label: input.label,
  });
}

export async function fetchKeyLogHead(
  session: RelayTenantSession
): Promise<{ seq: bigint; hash: Uint8Array; rootEpoch: number; uid: string }> {
  const body = await relayGatewayRequest(session, {
    path: '/api/auth/keylog/head',
    label: 'key log head',
  });
  const seq = body.seq;
  return {
    seq: BigInt(typeof seq === 'number' || typeof seq === 'string' ? seq : 0),
    hash: decodeBase64url(asText(body.hash)),
    rootEpoch: asNumber(body.rootEpoch),
    uid: asText(body.uid) || session.userId,
  };
}

/** 用根钥签一条 set-relays / meta-key 记录并经本机 gateway 走 hub=sync 提交。 */
export async function signAndSubmitRelayRecord(
  session: RelayTenantSession,
  input: { type: 'set-relays' | 'meta-key'; payload: Uint8Array }
): Promise<{ seq: number | string | undefined; hash: string | undefined }> {
  const head = await fetchKeyLogHead(session);
  const record = buildKeyLogRecord({ seq: head.seq, hash: head.hash }, head.rootEpoch, {
    uid: head.uid,
    type: input.type,
    payload: input.payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  const sig = signKeyLogRecordWithRoot(session.rootKey, bytes);
  const body = await relayGatewayRequest(session, {
    path: '/api/auth/keylog?hub=sync',
    method: 'POST',
    body: { bytes: encodeBase64url(bytes), sig: encodeBase64url(sig) },
    label: `${input.type} append`,
  });
  return {
    seq: body.seq as number | string | undefined,
    hash: typeof body.hash === 'string' ? body.hash : undefined,
  };
}

function relayRowFromJson(value: unknown): RelayStatusRelay {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    url: asText(raw.url),
    priority: asNumber(raw.priority),
    online: raw.online === true,
    attached: raw.attached === true,
    rttMs: typeof raw.rttMs === 'number' ? raw.rttMs : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    kicked: raw.kicked === true,
  };
}

export function parseRelayStatus(body: Record<string, unknown>): RelayStatusResponse {
  const mode = asText(body.mode, 'none');
  return {
    mode: mode === 'relay' || mode === 'hub' ? mode : 'none',
    tenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
    relays: Array.isArray(body.relays) ? body.relays.map(relayRowFromJson) : [],
    metaEpoch: asNumber(body.metaEpoch),
    nodesViaRelay: asNumber(body.nodesViaRelay),
    reauthRequired: body.reauthRequired === true,
    raw: body,
  };
}

export async function fetchRelayStatus(session: RelayTenantSession): Promise<RelayStatusResponse> {
  const body = await relayGatewayRequest(session, {
    path: '/api/mesh/relay/status',
    label: 'relay status',
  });
  return parseRelayStatus(body);
}

export async function pollRelayStatus(
  session: RelayTenantSession,
  io: RelayIo,
  predicate: (status: RelayStatusResponse) => boolean
): Promise<RelayStatusResponse> {
  const interval = io.pollIntervalMs ?? 500;
  const deadline = Date.now() + (io.pollTimeoutMs ?? 30_000);
  let last = await fetchRelayStatus(session);
  while (!predicate(last)) {
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
    last = await fetchRelayStatus(session);
  }
  return last;
}
