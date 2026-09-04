import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { encodeRedeemPopMessage } from '../../../../apps/gateway/src/hub/redeem-pop';
import {
  createNodeCertificate,
  decodeAuthorization,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  rootKeyFromSeed,
  signEd25519,
  verifyKeyLogChain,
} from '../../../shared/src/auth';
import {
  type RelayJoinToken,
  type RelayJoinTokenEntry,
  decodeRelayJoinToken,
  normalizeRelayUrl,
} from '../../../shared/src/relay';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import type { FetchLike } from '../lib/fetch-like';
import { joinUserKeyService, makeReplayPasskeyVerifier } from '../lib/keylog-passkey-replay';
import type { LocalAuthContext } from '../lib/local-auth';
import { RelayCaError, fetchPinnedRelayCa, pinRelayCa, storeRelayCaPin } from '../lib/relay-ca';
import { openRelayKeyLogPage, parseRelayKeyLogPage } from '../lib/relay-keylog';
import { persistRelayUplink } from '../lib/relay-store';
import { type TmexRoles, parseTmexRoles, roleNameFromFlags } from '../lib/roles';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import { type HubIo, JoinError, maybeRestart } from './hub';
import { assertChainUids } from './hub-join-verify';
import {
  RELAY_REDEEM_RESPONSE_MAX_BYTES,
  RelayApiError,
  joinRelayUrl,
  requestRelayJson,
} from './relay-shared';
import { withAuth } from './with-auth';

export type RelayJoinResult = {
  userId: string;
  relayUrl: string;
  relayUrls: string[];
  tenantId: string;
  admitted: boolean;
};

function log(io: HubIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

/** join 串里的中继表就是 failover 顺序；命令行给的 url 只能用来把其中一条提前。 */
export function orderRelayEntries(
  decoded: RelayJoinToken,
  preferredRaw: string
): RelayJoinTokenEntry[] {
  if (!preferredRaw) return [...decoded.relays];
  let preferred: string;
  try {
    preferred = normalizeRelayUrl(preferredRaw);
  } catch (error) {
    throw new JoinError(
      'invalid_url',
      error instanceof Error ? error.message : 'invalid relay url'
    );
  }
  const match = decoded.relays.find((entry) => entry.url === preferred);
  if (!match) {
    throw new JoinError('invalid_url', `relay url is not listed in the join token: ${preferred}`);
  }
  return [match, ...decoded.relays.filter((entry) => entry.url !== preferred)];
}

export const RELAY_ENROLLMENT_LOOKUP_MISSING =
  'this relay does not expose GET /api/relay/tenants/:tenantId/enrollments/:enrollPk; upgrade the relay to 1.1.23 or newer';

/** 只有传输层失败才换下一个中继：中继明确拒绝（4xx/5xx 契约错误）换一台也是同样的答案。 */
function isRelayTransportError(error: unknown): boolean {
  if (error instanceof RelayCaError) return error.transport;
  return !(error instanceof RelayApiError) && !(error instanceof JoinError);
}

/** 这台中继没有这条 enrollment：fan-out 部分失败时 r3 里可能仍带着它，换下一台。CA 指纹不符仍直接失败。 */
function isMissingEnrollmentError(error: unknown): boolean {
  if (error instanceof RelayApiError) {
    return error.code === 'RELAY_ENROLLMENT_UNKNOWN' || error.code === 'RELAY_NOT_FOUND';
  }
  return error instanceof JoinError && error.message === RELAY_ENROLLMENT_LOOKUP_MISSING;
}

function shouldTryNextRelay(error: unknown): boolean {
  return isRelayTransportError(error) || isMissingEnrollmentError(error);
}

/** 每台中继的租户令牌都是它自己签发的，跨中继复用只会被拒。 */
function relayHeaders(entry: RelayJoinTokenEntry): Record<string, string> {
  return { 'x-tmex-relay-token': encodeBase64url(entry.token) };
}

/**
 * 证书里的 uid 必须与租户 genesis 一致（`applyAdmitNode` 会比对），而 redeem 之前节点只有
 * join 串，所以先按 enroll_pk 取回中继保存的 authorization，从中读出 uid。
 */
async function fetchEnrollmentUid(input: {
  entry: RelayJoinTokenEntry;
  enrollPk: Uint8Array;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  let body: Record<string, unknown>;
  try {
    body = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(
        input.entry.url,
        `/api/relay/tenants/${input.entry.tenantId}/enrollments/${encodeURIComponent(
          encodeBase64url(input.enrollPk)
        )}`
      ),
      headers: relayHeaders(input.entry),
      label: 'relay enrollment lookup',
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    if (error instanceof RelayApiError && error.status === 404) {
      throw new JoinError('join_failed', RELAY_ENROLLMENT_LOOKUP_MISSING);
    }
    throw error;
  }
  const authorization = body.authorization;
  if (typeof authorization !== 'string') {
    throw new JoinError('join_failed', 'relay enrollment lookup returned no authorization');
  }
  return decodeAuthorization(decodeBase64url(authorization)).uid;
}

export type RelayRedeemResponse = {
  keyLog: Awaited<ReturnType<typeof openRelayKeyLogPage>>;
  relays: string[];
  tenantId: string;
};

async function redeemAtRelay(input: {
  entry: RelayJoinTokenEntry;
  decoded: RelayJoinToken;
  certificate: Uint8Array;
  certSig: Uint8Array;
  pop: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<RelayRedeemResponse> {
  const body = await requestRelayJson({
    fetcher: input.fetcher,
    url: joinRelayUrl(
      input.entry.url,
      `/api/relay/tenants/${input.entry.tenantId}/enrollments/redeem`
    ),
    method: 'POST',
    headers: relayHeaders(input.entry),
    body: {
      certificate: encodeBase64url(input.certificate),
      cert_sig: encodeBase64url(input.certSig),
      pop: input.pop,
    },
    label: 'relay redeem',
    maxBytes: RELAY_REDEEM_RESPONSE_MAX_BYTES,
    timeoutMs: input.timeoutMs,
  });
  const keyLog = await openRelayKeyLogPage(
    input.decoded.logKey,
    parseRelayKeyLogPage(body.key_log)
  );
  const relays = Array.isArray(body.relays)
    ? body.relays.filter((url): url is string => typeof url === 'string')
    : [];
  return {
    keyLog,
    relays,
    tenantId: typeof body.tenant_id === 'string' ? body.tenant_id : input.entry.tenantId,
  };
}

type PreparedJoin = {
  identity: Awaited<ReturnType<typeof ensureNodeIdentity>>;
  certificate: Uint8Array;
  certSig: Uint8Array;
  pop: string;
  uid: string;
};

async function prepareRelayJoin(input: {
  ctx: LocalAuthContext;
  decoded: RelayJoinToken;
  entry: RelayJoinTokenEntry;
  fetcher?: FetchLike;
  io: HubIo;
}): Promise<PreparedJoin> {
  const identity = await ensureNodeIdentity(input.ctx.identityStore);
  const enrollPk = rootKeyFromSeed(input.decoded.enrollSk).publicKey;
  const uid = await fetchEnrollmentUid({
    entry: input.entry,
    enrollPk,
    fetcher: input.fetcher,
    timeoutMs: input.io.relayTimeoutMs,
  });
  const cert = createNodeCertificate(input.decoded.enrollSk, {
    uid,
    edPk: identity.edPublicKey,
    x25519Pk: identity.x25519PublicKey,
    enrollPk,
    now: input.io.now?.() ?? Date.now(),
    nodeId: identity.nodeId,
  });
  const pop = encodeBase64url(
    signEd25519(
      identity.edPrivateKey,
      encodeRedeemPopMessage({
        enrollmentId: encodeBase64url(enrollPk),
        nodeId: identity.nodeId,
        certBytes: cert.certificateBytes,
      })
    )
  );
  return {
    identity,
    certificate: cert.certificateBytes,
    certSig: cert.certSig,
    pop,
    uid,
  };
}

type RelayAttempt = {
  prepared: PreparedJoin;
  redeemed: RelayRedeemResponse;
  entry: RelayJoinTokenEntry;
  /** 自签中继的 CA：redeem 成功后才落库，避免为一台连不上的中继留下 pin。 */
  pin: { caPem: string; fingerprint: string } | null;
};

/**
 * 带指纹的 join 串：任何带令牌的请求之前先把 CA 钉住，指纹不符直接拒绝（不退回系统 CA）。
 */
async function relayFetcherFor(input: {
  entry: RelayJoinTokenEntry;
  caFingerprint: string | undefined;
  io: HubIo;
}): Promise<{
  fetcher: FetchLike | undefined;
  pin: { caPem: string; fingerprint: string } | null;
}> {
  if (!input.caFingerprint) return { fetcher: input.io.fetcher, pin: null };
  const caPem = await fetchPinnedRelayCa({
    relayUrl: input.entry.url,
    fingerprint: input.caFingerprint,
    fetcher: input.io.fetcher,
    timeoutMs: input.io.relayTimeoutMs,
  });
  return {
    fetcher: pinRelayCa(input.io.fetcher, caPem),
    pin: { caPem, fingerprint: input.caFingerprint },
  };
}

async function redeemAgainstRelays(input: {
  ctx: LocalAuthContext;
  decoded: RelayJoinToken;
  entries: RelayJoinTokenEntry[];
  io: HubIo;
}): Promise<RelayAttempt> {
  let lastError: unknown;
  for (const entry of input.entries) {
    try {
      const { fetcher, pin } = await relayFetcherFor({
        entry,
        caFingerprint: input.decoded.caFingerprint,
        io: input.io,
      });
      const prepared = await prepareRelayJoin({
        ctx: input.ctx,
        decoded: input.decoded,
        entry,
        fetcher,
        io: input.io,
      });
      const redeemed = await redeemAtRelay({
        entry,
        decoded: input.decoded,
        certificate: prepared.certificate,
        certSig: prepared.certSig,
        pop: prepared.pop,
        fetcher,
        timeoutMs: input.io.relayTimeoutMs,
      });
      return { prepared, redeemed, entry, pin };
    } catch (error) {
      lastError = error;
      if (!shouldTryNextRelay(error)) break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new JoinError(
    isRelayTransportError(lastError) ? 'hub_unreachable' : 'join_failed',
    `relay join failed: ${message}`
  );
}

async function commitRelayJoin(input: {
  ctx: LocalAuthContext;
  decoded: RelayJoinToken;
  attempt: RelayAttempt;
  entries: RelayJoinTokenEntry[];
  name: string;
}): Promise<{ userId: string; admitted: boolean }> {
  const records = input.attempt.redeemed.keyLog;
  const prepared = input.attempt.prepared;
  // head hash 不能当「链尾」用：join 码生成之后租户完全可以继续追加记录。锚点语义（锚必须
  // 在链里、锚之后不得换根）由 `commitJoin(anchorHash)` 负责。
  const verified = await verifyKeyLogChain(records, input.decoded.rootPublicKey, undefined, {
    verifyPasskeyAssertion: makeReplayPasskeyVerifier(records),
  });
  if (!verified.ok) {
    throw new JoinError('join_failed', `key log rejected: ${verified.error}`);
  }
  const genesisUid = decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid;
  if (genesisUid !== prepared.uid) {
    throw new JoinError('join_failed', 'join uid mismatch');
  }
  assertChainUids(records, genesisUid);
  const admittedCert = verified.state.nodeCerts.get(prepared.identity.nodeIdHex);
  if (admittedCert?.revoked) {
    throw new JoinError('node_revoked', 'this node identity was revoked by the tenant');
  }
  const committed = await joinUserKeyService(input.ctx, records).commitJoin({
    records,
    expectedRootPublicKey: input.decoded.rootPublicKey,
    anchorHash: input.decoded.keyLogHeadHash,
    username: genesisUid,
    expectedUserId: genesisUid,
    identity: {
      nodeId: prepared.identity.nodeIdHex,
      hubUrl: null,
      edPrivateKey: prepared.identity.edPrivateKey,
      x25519PrivateKey: prepared.identity.x25519PrivateKey,
      certificateJson: JSON.stringify({
        x25519PublicKey: encodeBase64url(prepared.identity.x25519PublicKey),
        certificate: encodeBase64url(admittedCert?.certificateBytes ?? prepared.certificate),
      }),
      certSig: admittedCert?.certSig ?? prepared.certSig,
      userId: genesisUid,
    },
  });
  if (!committed.ok) {
    throw new JoinError('join_failed', `key log rejected: ${committed.error}`);
  }
  if (input.attempt.pin) {
    storeRelayCaPin(input.ctx.db, {
      relayUrl: input.attempt.entry.url,
      caPem: input.attempt.pin.caPem,
      fingerprint: input.attempt.pin.fingerprint,
    });
  }
  await persistRelayUplink(input.ctx, {
    relays: input.entries.map((item, index) => ({
      url: item.url,
      tenantId: item.tenantId,
      token: item.token,
      priority: index,
    })),
    logKey: input.decoded.logKey,
    name: input.name,
  });
  return { userId: genesisUid, admitted: Boolean(admittedCert) };
}

/** 本机可能同时是中继（`relay,node`）：加入别人的中继不该把自己的 relay 角色关掉。 */
export function relayJoinRoleName(current: string | undefined): string {
  let roles: TmexRoles;
  try {
    roles = parseTmexRoles(current);
  } catch {
    roles = { hub: false, node: false, relay: false };
  }
  return roleNameFromFlags({ hub: false, node: true, relay: roles.relay });
}

async function writeRelayNodeEnv(envPath: string): Promise<void> {
  await withEnvLock(async () => {
    const env = await readEnvFile(envPath);
    env.TMEX_ROLES = relayJoinRoleName(env.TMEX_ROLES);
    env.TMEX_HUB_URL = '';
    env.TMEX_HUB_PUBLIC_URL = '';
    await writeEnvFile(envPath, env);
  });
}

export async function runRelayJoin(
  parsed: ParsedArgs,
  urlRaw: string,
  token: string,
  io: HubIo = {}
): Promise<RelayJoinResult> {
  let decoded: RelayJoinToken;
  try {
    decoded = decodeRelayJoinToken(token);
  } catch (error) {
    throw new JoinError(
      'invalid_token',
      error instanceof Error ? error.message : 'invalid relay join token'
    );
  }
  const entries = orderRelayEntries(decoded, urlRaw);
  const name = asString(parsed.flags.name) || 'node';

  return await withAuth(parsed, io, async (ctx) => {
    const attempt = await redeemAgainstRelays({ ctx, decoded, entries, io });
    const committed = await commitRelayJoin({ ctx, decoded, attempt, entries, name });
    if (ctx.envPath) {
      await writeRelayNodeEnv(ctx.envPath);
    } else {
      process.env.TMEX_ROLES = relayJoinRoleName(
        ctx.env?.TMEX_ROLES ?? process.env.TMEX_ROLES ?? undefined
      );
      process.env.TMEX_HUB_URL = '';
      process.env.TMEX_HUB_PUBLIC_URL = '';
    }
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, `joined relay ${attempt.entry.url} (tenant ${attempt.entry.tenantId})`);
    if (!committed.admitted) {
      log(io, 'this node is pending; confirm it from the Nodes page of an existing node');
    }
    return {
      userId: committed.userId,
      relayUrl: attempt.entry.url,
      relayUrls: entries.map((entry) => entry.url),
      tenantId: attempt.entry.tenantId,
      admitted: committed.admitted,
    };
  });
}
