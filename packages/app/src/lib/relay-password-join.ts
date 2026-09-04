import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { buildSelfAdmitAndMetaKey } from '../../../../apps/gateway/src/auth/user-key-self-admit';
import { relayMemberFromRecord } from '../../../../apps/gateway/src/mesh/relay-key-log-sync';
import {
  bytesEqual,
  computeRecordHash,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  hubHostFromUrl,
  verifyKeyLogChain,
} from '../../../shared/src/auth';
import {
  kdfParamsFromWire,
  kdfParamsToWire,
  normalizeRelayUrl,
  openRelayPack,
  sealRelayKeyLogRecord,
  sealRelayPack,
  signRelayEnrollProof,
} from '../../../shared/src/relay';
import {
  RELAY_REDEEM_RESPONSE_MAX_BYTES,
  RelayApiError,
  joinRelayUrl,
  requestRelayJson,
} from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';
import { joinUserKeyService, makeReplayPasskeyVerifier } from './keylog-passkey-replay';
import type { LocalAuthContext } from './local-auth';
import { deriveRootKey } from './password';
import { RelayCaError, fetchPinnedRelayCa, pinRelayCa, storeRelayCaPin } from './relay-ca';
import { openRelayKeyLogPage, parseRelayKeyLogPage } from './relay-keylog';
import { persistRelayUplink } from './relay-store';

export class RelayPasswordJoinError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RelayPasswordJoinError';
    this.code = code;
  }
}

export type RelayPasswordJoinInput = {
  relayUrl: string;
  tenantId: string;
  password: string;
  name?: string;
  caFingerprint?: string;
};

export type RelayPasswordJoinDeps = {
  auth: LocalAuthContext;
  now?: () => number;
  fetcher?: FetchLike;
  timeoutMs?: number;
};

export type RelayPasswordJoinResult = {
  userId: string;
  relayUrl: string;
  tenantId: string;
};

function tenantHeaders(token: Uint8Array): Record<string, string> {
  return { 'x-tmex-relay-token': encodeBase64url(token) };
}

async function assertJoinable(ctx: LocalAuthContext): Promise<void> {
  if (ctx.userStore.listUsers().length > 0) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine already has a mesh user; password join refuses to overwrite it'
    );
  }
  const identity = await ctx.identityStore.load();
  if (identity?.userId) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine already has a node identity bound to a mesh user'
    );
  }
}

async function pinnedFetcher(input: {
  relayUrl: string;
  caFingerprint: string | undefined;
  fetcher: FetchLike | undefined;
  timeoutMs: number | undefined;
}): Promise<{
  fetcher: FetchLike | undefined;
  pin: { caPem: string; fingerprint: string } | null;
}> {
  if (!input.caFingerprint) return { fetcher: input.fetcher, pin: null };
  const caPem = await fetchPinnedRelayCa({
    relayUrl: input.relayUrl,
    fingerprint: input.caFingerprint,
    fetcher: input.fetcher,
    timeoutMs: input.timeoutMs,
  });
  return {
    fetcher: pinRelayCa(input.fetcher, caPem),
    pin: { caPem, fingerprint: input.caFingerprint },
  };
}

async function downloadKeyLog(input: {
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  logKey: Uint8Array;
  fetcher?: FetchLike;
  timeoutMs?: number;
}) {
  const items: ReturnType<typeof parseRelayKeyLogPage> = [];
  let fromSeq = 1;
  for (;;) {
    const body = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(
        input.relayUrl,
        `/api/relay/tenants/${input.tenantId}/keylog?from_seq=${fromSeq}&limit=64`
      ),
      headers: tenantHeaders(input.token),
      label: 'relay key log',
      maxBytes: RELAY_REDEEM_RESPONSE_MAX_BYTES,
      timeoutMs: input.timeoutMs,
    });
    const page = parseRelayKeyLogPage(body.key_log);
    items.push(...page);
    if (body.has_more !== true || page.length === 0) break;
    const last = page[page.length - 1];
    fromSeq = Number(last?.seq ?? fromSeq) + 1;
    if (!Number.isFinite(fromSeq) || fromSeq <= 0) break;
  }
  return openRelayKeyLogPage(input.logKey, items);
}

function pinHead(
  records: Awaited<ReturnType<typeof openRelayKeyLogPage>>,
  seq: bigint,
  hash: Uint8Array
) {
  if (records.length < Number(seq) || seq < 1n) {
    throw new RelayPasswordJoinError(
      'head_hash_mismatch',
      `key log is shorter than the sealed pack head (have ${records.length}, need seq ${String(seq)})`
    );
  }
  const pinned = records[Number(seq) - 1];
  if (!pinned || !bytesEqual(computeRecordHash(pinned.bytes, pinned.sig), hash)) {
    throw new RelayPasswordJoinError(
      'head_hash_mismatch',
      'key log record at the sealed pack head does not match head_hash'
    );
  }
}

function relaysForPersist(
  stateRelays: { url: string; tenantId: string; token: Uint8Array; priority: number }[] | undefined,
  joined: { url: string; tenantId: string; token: Uint8Array }
) {
  const rows = [...(stateRelays ?? [])].sort((a, b) => a.priority - b.priority);
  if (!rows.some((row) => row.url === joined.url)) {
    rows.unshift({ ...joined, priority: 0 });
  }
  return rows.map((row, index) => ({ ...row, priority: index }));
}

async function appendRecordsToRelay(input: {
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  logKey: Uint8Array;
  records: { bytes: Uint8Array; sig: Uint8Array }[];
  fetcher?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  for (const record of input.records) {
    const seq = decodeKeyLogRecord(record.bytes).seq;
    const blob = await sealRelayKeyLogRecord(input.logKey, record);
    const member = relayMemberFromRecord(record);
    await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(input.relayUrl, `/api/relay/tenants/${input.tenantId}/keylog`),
      method: 'POST',
      headers: tenantHeaders(input.token),
      body: {
        seq: Number(seq) <= Number.MAX_SAFE_INTEGER ? Number(seq) : seq.toString(),
        blob,
        ...(member ? { member } : {}),
      },
      label: 'relay key log append',
      timeoutMs: input.timeoutMs,
    });
  }
}

async function uploadPack(input: {
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  rootKey: { seed: Uint8Array; publicKey: Uint8Array };
  kdfParams: ReturnType<typeof kdfParamsFromWire>;
  logKey: Uint8Array;
  headSeq: bigint;
  headHash: Uint8Array;
  rootEpoch: number;
  fetcher?: FetchLike;
  timeoutMs?: number;
  now: number;
}): Promise<void> {
  if (!input.kdfParams) throw new RelayPasswordJoinError('join_failed', 'missing kdf params');
  const tokenCopy = new Uint8Array(input.token);
  const logCopy = new Uint8Array(input.logKey);
  let sealed: Uint8Array;
  try {
    sealed = await sealRelayPack({
      rootSeed: input.rootKey.seed,
      tenantId: input.tenantId,
      rootPublicKey: input.rootKey.publicKey,
      rootEpoch: input.rootEpoch,
      plaintext: {
        log_key: logCopy,
        token: tokenCopy,
        head_seq: input.headSeq,
        head_hash: input.headHash,
        issued_at: BigInt(input.now),
      },
    });
  } finally {
    tokenCopy.fill(0);
    logCopy.fill(0);
  }
  await requestRelayJson({
    fetcher: input.fetcher,
    url: joinRelayUrl(input.relayUrl, `/api/relay/tenants/${input.tenantId}/pack`),
    method: 'POST',
    headers: tenantHeaders(input.token),
    body: {
      sealed_pack: encodeBase64url(sealed),
      kdf_params: kdfParamsToWire(input.kdfParams),
      root_epoch: input.rootEpoch,
      head_seq:
        Number(input.headSeq) <= Number.MAX_SAFE_INTEGER
          ? Number(input.headSeq)
          : input.headSeq.toString(),
    },
    label: 'relay pack upload',
    timeoutMs: input.timeoutMs,
  });
}

export async function performRelayPasswordJoin(
  input: RelayPasswordJoinInput,
  deps: RelayPasswordJoinDeps
): Promise<RelayPasswordJoinResult> {
  await assertJoinable(deps.auth);
  let relayUrl: string;
  try {
    relayUrl = normalizeRelayUrl(input.relayUrl);
  } catch (error) {
    throw new RelayPasswordJoinError(
      'invalid_url',
      error instanceof Error ? error.message : 'invalid relay url'
    );
  }
  const tenantId = input.tenantId.trim().toLowerCase();
  const timeoutMs = deps.timeoutMs;
  const { fetcher, pin } = await pinnedFetcher({
    relayUrl,
    caFingerprint: input.caFingerprint,
    fetcher: deps.fetcher,
    timeoutMs,
  });
  let rootKey: Awaited<ReturnType<typeof deriveRootKey>> | undefined;
  try {
    const kdfBody = await requestRelayJson({
      fetcher,
      url: joinRelayUrl(relayUrl, `/api/relay/tenants/${tenantId}/kdf`),
      label: 'relay tenant kdf',
      timeoutMs,
    });
    const kdfParams = kdfParamsFromWire(kdfBody.kdf_params);
    if (!kdfParams) {
      throw new RelayPasswordJoinError('join_failed', 'relay kdf params are malformed');
    }
    rootKey = await deriveRootKey(input.password, kdfParams);
    if (!rootKey) {
      throw new RelayPasswordJoinError('join_failed', 'failed to derive root key');
    }
    const now = deps.now?.() ?? Date.now();
    const proof = signRelayEnrollProof(rootKey, { relayHost: hubHostFromUrl(relayUrl), ts: now });
    const joined = await requestRelayJson({
      fetcher,
      url: joinRelayUrl(relayUrl, '/api/relay/enroll'),
      method: 'POST',
      body: {
        mode: 'join',
        tenant_id: tenantId,
        root_public_key: encodeBase64url(rootKey.publicKey),
        root_epoch: typeof kdfBody.root_epoch === 'number' ? kdfBody.root_epoch : 0,
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      },
      label: 'relay password join',
      timeoutMs,
    });
    const rootEpoch = typeof joined.root_epoch === 'number' ? joined.root_epoch : 0;
    if (!joined.sealed_pack || typeof joined.sealed_pack !== 'string') {
      throw new RelayPasswordJoinError('join_failed', 'relay returned no sealed pack');
    }
    const packKdf = kdfParamsFromWire(joined.kdf_params) ?? kdfParams;
    const pack = await openRelayPack({
      rootSeed: rootKey.seed,
      tenantId,
      rootPublicKey: rootKey.publicKey,
      rootEpoch,
      sealedPack: decodeBase64url(joined.sealed_pack),
    });
    const records = await downloadKeyLog({
      relayUrl,
      tenantId,
      token: pack.token,
      logKey: pack.log_key,
      fetcher,
      timeoutMs,
    });
    pinHead(records, pack.head_seq, pack.head_hash);
    const verified = await verifyKeyLogChain(records, rootKey.publicKey, undefined, {
      verifyPasskeyAssertion: makeReplayPasskeyVerifier(records),
    });
    if (!verified.ok) {
      throw new RelayPasswordJoinError('join_failed', `key log rejected: ${verified.error}`);
    }
    const genesisUid = decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid;
    const identity = await ensureNodeIdentity(deps.auth.identityStore);
    const committed = await joinUserKeyService(deps.auth, records).commitJoin({
      records,
      expectedRootPublicKey: rootKey.publicKey,
      anchorHash: pack.head_hash,
      username: genesisUid,
      expectedUserId: genesisUid,
      identity: {
        nodeId: identity.nodeIdHex,
        hubUrl: null,
        edPrivateKey: identity.edPrivateKey,
        x25519PrivateKey: identity.x25519PrivateKey,
        certificateJson: JSON.stringify({
          x25519PublicKey: encodeBase64url(identity.x25519PublicKey),
        }),
        certSig: new Uint8Array(0),
        userId: genesisUid,
      },
    });
    if (!committed.ok) {
      throw new RelayPasswordJoinError('join_failed', `key log rejected: ${committed.error}`);
    }
    const built = await buildSelfAdmitAndMetaKey({
      service: deps.auth.userKeys,
      userId: genesisUid,
      identity,
      rootKey,
      now,
    });
    const applied = await deps.auth.userKeys.applyMany(genesisUid, built.records);
    if (!applied.ok) {
      throw new RelayPasswordJoinError('join_failed', `self-admit failed: ${applied.error}`);
    }
    const state = deps.auth.userKeys.currentState(genesisUid);
    await persistRelayUplink(deps.auth, {
      relays: relaysForPersist(state.relays?.relays, {
        url: relayUrl,
        tenantId,
        token: pack.token,
      }),
      logKey: pack.log_key,
      metaKey: { epoch: built.metaEpoch, key: built.metaKey },
      name: input.name ?? 'node',
      now,
    });
    await appendRecordsToRelay({
      relayUrl,
      tenantId,
      token: pack.token,
      logKey: pack.log_key,
      records: built.records,
      fetcher,
      timeoutMs,
    });
    const head = deps.auth.keyLogStore.head(genesisUid);
    await uploadPack({
      relayUrl,
      tenantId,
      token: pack.token,
      rootKey,
      kdfParams: packKdf,
      logKey: pack.log_key,
      headSeq: head?.seq ?? BigInt(applied.seq),
      headHash: head?.hash ?? applied.hash,
      rootEpoch: state.rootEpoch,
      fetcher,
      timeoutMs,
      now,
    });
    if (pin) {
      storeRelayCaPin(deps.auth.db, {
        relayUrl,
        caPem: pin.caPem,
        fingerprint: pin.fingerprint,
      });
    }
    pack.log_key.fill(0);
    pack.token.fill(0);
    built.metaKey.fill(0);
    return { userId: genesisUid, relayUrl, tenantId };
  } catch (error) {
    if (error instanceof RelayPasswordJoinError) throw error;
    if (error instanceof RelayCaError || error instanceof RelayApiError) {
      throw new RelayPasswordJoinError('join_failed', error.message);
    }
    throw new RelayPasswordJoinError(
      'join_failed',
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    rootKey?.seed.fill(0);
  }
}
