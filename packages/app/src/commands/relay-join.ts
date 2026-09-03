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
  decodeRelayJoinToken,
  normalizeRelayUrl,
} from '../../../shared/src/relay';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import type { LocalAuthContext } from '../lib/local-auth';
import { openRelayKeyLogPage, parseRelayKeyLogPage } from '../lib/relay-keylog';
import { persistRelayUplink } from '../lib/relay-store';
import { asString } from '../lib/validate';
import type { ParsedArgs } from '../types';
import { type HubIo, JoinError, maybeRestart } from './hub';
import { assertChainUids } from './hub-join-verify';
import { RelayApiError, joinRelayUrl, requestRelayJson } from './relay-shared';
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

/** join 串里的地址表就是 failover 顺序；命令行给的 url 只能用来把其中一个提前。 */
export function orderRelayUrls(decoded: RelayJoinToken, preferredRaw: string): string[] {
  if (!preferredRaw) return [...decoded.relayUrls];
  let preferred: string;
  try {
    preferred = normalizeRelayUrl(preferredRaw);
  } catch (error) {
    throw new JoinError(
      'invalid_url',
      error instanceof Error ? error.message : 'invalid relay url'
    );
  }
  if (!decoded.relayUrls.includes(preferred)) {
    throw new JoinError('invalid_url', `relay url is not listed in the join token: ${preferred}`);
  }
  return [preferred, ...decoded.relayUrls.filter((url) => url !== preferred)];
}

/** 只有传输层失败才换下一个中继：中继明确拒绝（4xx/5xx 契约错误）换一台也是同样的答案。 */
function isRelayTransportError(error: unknown): boolean {
  return !(error instanceof RelayApiError) && !(error instanceof JoinError);
}

export const RELAY_ENROLLMENT_LOOKUP_MISSING =
  'this relay does not expose GET /api/relay/tenants/:tenantId/enrollments/:enrollPk; upgrade the relay to 1.1.23 or newer';

function relayHeaders(decoded: RelayJoinToken): Record<string, string> {
  return { 'x-tmex-relay-token': encodeBase64url(decoded.token) };
}

/**
 * 证书里的 uid 必须与租户 genesis 一致（`applyAdmitNode` 会比对），而 redeem 之前节点只有
 * join 串，所以先按 enroll_pk 取回中继保存的 authorization，从中读出 uid。
 */
async function fetchEnrollmentUid(input: {
  relayUrl: string;
  decoded: RelayJoinToken;
  enrollPk: Uint8Array;
  fetcher?: typeof fetch;
}): Promise<string> {
  let body: Record<string, unknown>;
  try {
    body = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(
        input.relayUrl,
        `/api/relay/tenants/${input.decoded.tenantId}/enrollments/${encodeURIComponent(
          encodeBase64url(input.enrollPk)
        )}`
      ),
      headers: relayHeaders(input.decoded),
      label: 'relay enrollment lookup',
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
  relayUrl: string;
  decoded: RelayJoinToken;
  certificate: Uint8Array;
  certSig: Uint8Array;
  pop: string;
  fetcher?: typeof fetch;
}): Promise<RelayRedeemResponse> {
  const body = await requestRelayJson({
    fetcher: input.fetcher,
    url: joinRelayUrl(
      input.relayUrl,
      `/api/relay/tenants/${input.decoded.tenantId}/enrollments/redeem`
    ),
    method: 'POST',
    headers: relayHeaders(input.decoded),
    body: {
      certificate: encodeBase64url(input.certificate),
      cert_sig: encodeBase64url(input.certSig),
      pop: input.pop,
    },
    label: 'relay redeem',
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
    tenantId: typeof body.tenant_id === 'string' ? body.tenant_id : input.decoded.tenantId,
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
  relayUrl: string;
  io: HubIo;
}): Promise<PreparedJoin> {
  const identity = await ensureNodeIdentity(input.ctx.identityStore);
  const enrollPk = rootKeyFromSeed(input.decoded.enrollSk).publicKey;
  const uid = await fetchEnrollmentUid({
    relayUrl: input.relayUrl,
    decoded: input.decoded,
    enrollPk,
    fetcher: input.io.fetcher,
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

async function redeemAgainstRelays(input: {
  ctx: LocalAuthContext;
  decoded: RelayJoinToken;
  relayUrls: string[];
  io: HubIo;
}): Promise<{ prepared: PreparedJoin; redeemed: RelayRedeemResponse; relayUrl: string }> {
  let lastError: unknown;
  for (const relayUrl of input.relayUrls) {
    try {
      const prepared = await prepareRelayJoin({
        ctx: input.ctx,
        decoded: input.decoded,
        relayUrl,
        io: input.io,
      });
      const redeemed = await redeemAtRelay({
        relayUrl,
        decoded: input.decoded,
        certificate: prepared.certificate,
        certSig: prepared.certSig,
        pop: prepared.pop,
        fetcher: input.io.fetcher,
      });
      return { prepared, redeemed, relayUrl };
    } catch (error) {
      lastError = error;
      if (!isRelayTransportError(error)) break;
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
  prepared: PreparedJoin;
  redeemed: RelayRedeemResponse;
  relayUrls: string[];
  name: string;
}): Promise<{ userId: string; admitted: boolean }> {
  const records = input.redeemed.keyLog;
  const verified = await verifyKeyLogChain(
    records,
    input.decoded.rootPublicKey,
    input.decoded.keyLogHeadHash
  );
  if (!verified.ok) {
    throw new JoinError('join_failed', `key log rejected: ${verified.error}`);
  }
  const genesisUid = decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid;
  if (genesisUid !== input.prepared.uid) {
    throw new JoinError('join_failed', 'join uid mismatch');
  }
  assertChainUids(records, genesisUid);
  const admittedCert = verified.state.nodeCerts.get(input.prepared.identity.nodeIdHex);
  if (admittedCert?.revoked) {
    throw new JoinError('node_revoked', 'this node identity was revoked by the tenant');
  }
  const committed = await input.ctx.userKeys.commitJoin({
    records,
    expectedRootPublicKey: input.decoded.rootPublicKey,
    anchorHash: input.decoded.keyLogHeadHash,
    username: genesisUid,
    expectedUserId: genesisUid,
    identity: {
      nodeId: input.prepared.identity.nodeIdHex,
      hubUrl: null,
      edPrivateKey: input.prepared.identity.edPrivateKey,
      x25519PrivateKey: input.prepared.identity.x25519PrivateKey,
      certificateJson: JSON.stringify({
        x25519PublicKey: encodeBase64url(input.prepared.identity.x25519PublicKey),
        certificate: encodeBase64url(admittedCert?.certificateBytes ?? input.prepared.certificate),
      }),
      certSig: admittedCert?.certSig ?? input.prepared.certSig,
      userId: genesisUid,
    },
  });
  if (!committed.ok) {
    throw new JoinError('join_failed', `key log rejected: ${committed.error}`);
  }
  await persistRelayUplink(input.ctx, {
    relays: input.relayUrls.map((url, index) => ({
      url,
      tenantId: input.decoded.tenantId,
      token: input.decoded.token,
      priority: index,
    })),
    logKey: input.decoded.logKey,
    name: input.name,
  });
  return { userId: genesisUid, admitted: Boolean(admittedCert) };
}

async function writeRelayNodeEnv(envPath: string): Promise<void> {
  await withEnvLock(async () => {
    const env = await readEnvFile(envPath);
    env.TMEX_ROLES = 'node';
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
  const relayUrls = orderRelayUrls(decoded, urlRaw);
  const name = asString(parsed.flags.name) || 'node';

  return await withAuth(parsed, io, async (ctx) => {
    const { prepared, redeemed, relayUrl } = await redeemAgainstRelays({
      ctx,
      decoded,
      relayUrls,
      io,
    });
    const committed = await commitRelayJoin({
      ctx,
      decoded,
      prepared,
      redeemed,
      relayUrls,
      name,
    });
    if (ctx.envPath) {
      await writeRelayNodeEnv(ctx.envPath);
    } else {
      process.env.TMEX_ROLES = 'node';
      process.env.TMEX_HUB_URL = '';
      process.env.TMEX_HUB_PUBLIC_URL = '';
    }
    if (ctx.installDir) {
      await maybeRestart(parsed, io, ctx.installDir);
    }
    log(io, `joined relay ${relayUrl} (tenant ${decoded.tenantId})`);
    if (!committed.admitted) {
      log(io, 'this node is pending; confirm it from the Nodes page of an existing node');
    }
    return {
      userId: committed.userId,
      relayUrl,
      relayUrls,
      tenantId: decoded.tenantId,
      admitted: committed.admitted,
    };
  });
}
