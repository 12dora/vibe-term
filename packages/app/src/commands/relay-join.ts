import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { RelayCaPinStore } from '../../../../apps/gateway/src/auth/relay-ca-pin-store';
import { encodeRedeemPopMessage } from '../../../../apps/gateway/src/relay/redeem-pop';
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
import { RELAY_TOKEN_HEADER, assignHeaderPair } from '../../../shared/src/http/mesh-headers';
import {
  type RelayJoinToken,
  type RelayJoinTokenEntry,
  decodeRelayJoinToken,
  isRelayJoinToken,
} from '../../../shared/src/relay';
import { requireFlagValue } from '../lib/args';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import type { FetchLike } from '../lib/fetch-like';
import { joinUserKeyService, makeReplayPasskeyVerifier } from '../lib/keylog-passkey-replay';
import type { LocalAuthContext } from '../lib/local-auth';
import {
  fetchPinnedRelayCa,
  pinRelayCa,
  resolveRelayJoinCaFingerprint,
  storeRelayCaPin,
} from '../lib/relay-ca';
import { openRelayKeyLogPage, parseRelayKeyLogPage } from '../lib/relay-keylog';
import { persistRelayUplink, relaysForTokenJoin } from '../lib/relay-store';
import { asString } from '../lib/validate';
import { applyRelayPasswordJoinEnv, relayJoinRoleName } from '../runtime/setup-shared';
import type { ParsedArgs } from '../types';
import type { CliIo } from './cli-io';
import { enableDirectForOnboarding } from './direct';
import { JoinError, NODE_REVOKED_REJOIN_ERROR } from './join-error';
import { assertChainUids } from './join-verify';
import { orderRelayEntries } from './relay-join-entries';
import {
  RELAY_ENROLLMENT_LOOKUP_MISSING,
  isBareNotFound,
  shouldTryNextRelay,
} from './relay-join-failover';
import { joinFailureMessage } from './relay-join-failure';
import { logRelayJoinSummary } from './relay-join-summary';
import { type RelayAdmissionWatch, settleRelayAdmission } from './relay-join-wait';
import { RELAY_REDEEM_RESPONSE_MAX_BYTES, joinRelayUrl, requestRelayJson } from './relay-shared';
import { type RestartOutcome, maybeRestart } from './restart';
import { withAuth } from './with-auth';

export { orderRelayEntries, relayJoinRoleName };

export type RelayJoinResult = {
  userId: string;
  relayUrl: string;
  relayUrls: string[];
  tenantId: string;
  admitted: boolean;
};

/** 未被批准时带上盯日志所需的上下文（已批准为 null），以及服务重启的结果。 */
export type RelayJoinRun = RelayJoinResult & {
  watch: RelayAdmissionWatch | null;
  restart: RestartOutcome;
};

function log(io: CliIo | undefined, message: string): void {
  (io?.log ?? console.log)(message);
}

/** 每台中继的租户令牌都是它自己签发的，跨中继复用只会被拒。 */
function relayHeaders(entry: RelayJoinTokenEntry): Record<string, string> {
  return assignHeaderPair({}, RELAY_TOKEN_HEADER, encodeBase64url(entry.token));
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
    if (isBareNotFound(error)) {
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
  io: CliIo;
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
  fetcher: FetchLike | undefined;
  /** 自签中继的 CA：redeem 成功后才落库，避免为一台连不上的中继留下 pin。 */
  pin: { caPem: string; fingerprint: string } | null;
};

/**
 * 带指纹的 join 串：任何带令牌的请求之前先把 CA 钉住，指纹不符直接拒绝（不退回系统 CA）。
 */
async function relayFetcherFor(input: {
  entry: RelayJoinTokenEntry;
  caFingerprint: string | undefined;
  io: CliIo;
  db: LocalAuthContext['db'];
}): Promise<{
  fetcher: FetchLike | undefined;
  pin: { caPem: string; fingerprint: string } | null;
}> {
  if (!input.caFingerprint) {
    new RelayCaPinStore(input.db).delete(input.entry.url);
    return { fetcher: input.io.fetcher, pin: null };
  }
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
  io: CliIo;
  caFingerprint: string | undefined;
}): Promise<RelayAttempt> {
  let lastError: unknown;
  for (const entry of input.entries) {
    try {
      const { fetcher, pin } = await relayFetcherFor({
        entry,
        caFingerprint: input.caFingerprint,
        io: input.io,
        db: input.ctx.db,
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
      return { prepared, redeemed, entry, fetcher, pin };
    } catch (error) {
      lastError = error;
      if (!shouldTryNextRelay(error)) break;
    }
  }
  throw lastError;
}

async function commitRelayJoin(input: {
  ctx: LocalAuthContext;
  decoded: RelayJoinToken;
  attempt: RelayAttempt;
  entries: RelayJoinTokenEntry[];
  name: string;
}): Promise<{ userId: string; admitted: boolean; relayUrls: string[] }> {
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
    throw new JoinError('node_revoked', NODE_REVOKED_REJOIN_ERROR);
  }
  const committed = await joinUserKeyService(input.ctx, records).commitJoin({
    records,
    expectedRootPublicKey: input.decoded.rootPublicKey,
    anchorHash: input.decoded.keyLogHeadHash,
    username: genesisUid,
    expectedUserId: genesisUid,
    identity: {
      nodeId: prepared.identity.nodeIdHex,
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
  const relayUrls = await persistRelayUplink(input.ctx, {
    relays: relaysForTokenJoin(verified.state.relays?.relays, input.entries),
    logKey: input.decoded.logKey,
    name: input.name,
  });
  return { userId: genesisUid, admitted: Boolean(admittedCert), relayUrls };
}

async function writeRelayNodeEnv(envPath: string): Promise<void> {
  await withEnvLock(async () => {
    await writeEnvFile(envPath, applyRelayPasswordJoinEnv(await readEnvFile(envPath)));
  });
}

/** 把本机切成中继成员：写角色、装直连插件、按需重启服务，返回重启结果。 */
async function applyNodeSetup(
  ctx: LocalAuthContext,
  parsed: ParsedArgs,
  io: CliIo
): Promise<RestartOutcome> {
  if (ctx.envPath) {
    await writeRelayNodeEnv(ctx.envPath);
  } else {
    process.env.VIBETERM_ROLES = relayJoinRoleName(
      ctx.env?.VIBETERM_ROLES ?? process.env.VIBETERM_ROLES ?? undefined
    );
    for (const key of ['VIBETERM_HUB_URL', 'VIBETERM_HUB_PUBLIC_URL'] as const) {
      delete process.env[key];
    }
  }
  if (!ctx.installDir) return 'skipped';
  await enableDirectForOnboarding(ctx.installDir, io, ctx.envPath || undefined);
  return await maybeRestart(parsed, io, ctx.installDir);
}

function admissionWatch(attempt: RelayAttempt, decoded: RelayJoinToken): RelayAdmissionWatch {
  return {
    entry: attempt.entry,
    headers: relayHeaders(attempt.entry),
    fetcher: attempt.fetcher,
    logKey: decoded.logKey,
    rootPublicKey: decoded.rootPublicKey,
    nodeIdHex: attempt.prepared.identity.nodeIdHex,
    records: [...attempt.redeemed.keyLog],
  };
}

export async function runRelayJoin(
  parsed: ParsedArgs,
  urlRaw: string,
  token: string,
  io: CliIo = {}
): Promise<RelayJoinRun> {
  let decoded: RelayJoinToken;
  try {
    decoded = decodeRelayJoinToken(token);
  } catch (error) {
    throw new JoinError(
      'invalid_token',
      error instanceof Error ? error.message : 'invalid relay join token'
    );
  }
  const entries = orderRelayEntries(decoded, urlRaw, (message) => log(io, message));
  const name = asString(parsed.flags.name) || 'node';
  const caFingerprint = resolveRelayJoinCaFingerprint(
    decoded.caFingerprint,
    requireFlagValue(parsed.flags, 'ca-fingerprint')
  );

  return await withAuth(parsed, io, async (ctx) => {
    const attempt = await redeemAgainstRelays({ ctx, decoded, entries, io, caFingerprint });
    const committed = await commitRelayJoin({ ctx, decoded, attempt, entries, name });
    const restart = await applyNodeSetup(ctx, parsed, io);
    logRelayJoinSummary((message) => log(io, message), {
      url: attempt.entry.url,
      tenantId: attempt.entry.tenantId,
      relayUrls: committed.relayUrls,
      env: ctx.env,
      pending: !committed.admitted,
      restart,
    });
    return {
      userId: committed.userId,
      relayUrl: attempt.entry.url,
      relayUrls: committed.relayUrls,
      tenantId: attempt.entry.tenantId,
      admitted: committed.admitted,
      watch: committed.admitted ? null : admissionWatch(attempt, decoded),
      restart,
    };
  });
}

export function relayJoinUrlFromParsed(parsed: ParsedArgs): string {
  const rest = parsed.positionals.filter((item) => item !== 'relay' && item !== 'join');
  return rest[0] ?? '';
}

async function dispatchRelayJoin(parsed: ParsedArgs, io: CliIo): Promise<RelayJoinResult> {
  const token = requireFlagValue(parsed.flags, 'token');
  const tenant = asString(parsed.flags.tenant);
  if (token && (Object.hasOwn(parsed.flags, 'password') || tenant)) {
    throw new Error('relay join --token and --tenant/--password are mutually exclusive');
  }
  if (!token) {
    const { runRelayPasswordJoin } = await import('./relay-password-join');
    const joined = await runRelayPasswordJoin(parsed, io);
    return {
      userId: joined.userId,
      relayUrl: joined.relayUrl,
      relayUrls: joined.relayUrls,
      tenantId: joined.tenantId,
      admitted: true,
    };
  }
  if (!isRelayJoinToken(token)) {
    throw new JoinError('invalid_token', 'relay join --token must be an r3. join token');
  }
  const { watch, restart, ...result } = await runRelayJoin(
    parsed,
    relayJoinUrlFromParsed(parsed),
    token,
    io
  );
  await settleRelayAdmission(parsed, watch, io, restart);
  return result;
}

/** CLI entry: `--token r3.…` or `--tenant` + password. 任何失败都带「加入失败」前缀。 */
export async function runRelayJoinCommand(
  parsed: ParsedArgs,
  io: CliIo = {}
): Promise<RelayJoinResult> {
  try {
    return await dispatchRelayJoin(parsed, io);
  } catch (error) {
    throw new Error(joinFailureMessage(error), { cause: error });
  }
}
