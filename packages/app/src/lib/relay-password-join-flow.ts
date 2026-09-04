import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { buildSelfAdmitAndMetaKey } from '../../../../apps/gateway/src/auth/user-key-self-admit';
import type { UserKeyService } from '../../../../apps/gateway/src/auth/user-key-service';
import {
  bytesEqual,
  computeRecordHash,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  hubHostFromUrl,
  verifyKeyLogChain,
} from '../../../shared/src/auth';
import type { KdfParams, RootKey, UserKeyState } from '../../../shared/src/auth';
import { assertKdfParamsWithinBudget } from '../../../shared/src/auth/root-key';
import type { RelayPackPlaintext } from '../../../shared/src/relay';
import {
  kdfParamsFromWire,
  kdfParamsToWire,
  openRelayPack,
  sealRelayPack,
  signRelayEnrollProof,
} from '../../../shared/src/relay';
import {
  RELAY_REDEEM_RESPONSE_MAX_BYTES,
  joinRelayUrl,
  requestRelayJson,
} from '../commands/relay-shared';
import type { FetchLike } from './fetch-like';
import { joinUserKeyService, makeReplayPasskeyVerifier } from './keylog-passkey-replay';
import type { LocalAuthContext } from './local-auth';
import { deriveRootKey } from './password';
import { storeRelayCaPin } from './relay-ca';
import { openRelayKeyLogPage, parseRelayKeyLogPage } from './relay-keylog';
import { type AppendPairResult, appendAdmitThenMetaRetrying } from './relay-password-join-append';
import { persistRelayUplink } from './relay-store';

export class RelayPasswordJoinError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RelayPasswordJoinError';
    this.code = code;
  }
}

export type JoinTransport = {
  relayUrl: string;
  tenantId: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
};

export type JoinPackPhase = {
  rootKey: RootKey;
  pack: RelayPackPlaintext;
  packKdf: KdfParams;
  rootEpoch: number;
  now: number;
};

export type JoinLogPhase = {
  records: Awaited<ReturnType<typeof openRelayKeyLogPage>>;
  genesisUid: string;
  state: UserKeyState;
};

export type JoinAdmitPhase = {
  builtRecords: { bytes: Uint8Array; sig: Uint8Array }[];
  appliedSeq: number;
  appliedHash: Uint8Array;
  rootEpoch: number;
  metaKey: Uint8Array;
};

function tenantHeaders(token: Uint8Array): Record<string, string> {
  return { 'x-tmex-relay-token': encodeBase64url(token) };
}

export function pinHead(
  records: Awaited<ReturnType<typeof openRelayKeyLogPage>>,
  seq: bigint,
  hash: Uint8Array
): void {
  if (records.length < Number(seq) || seq < 1n) {
    throw new RelayPasswordJoinError(
      'relay_pack_invalid',
      `key log is shorter than the sealed pack head (have ${records.length}, need seq ${String(seq)})`
    );
  }
  const pinned = records[Number(seq) - 1];
  if (!pinned || !bytesEqual(computeRecordHash(pinned.bytes, pinned.sig), hash)) {
    throw new RelayPasswordJoinError(
      'relay_pack_invalid',
      'key log record at the sealed pack head does not match head_hash'
    );
  }
}

export function relaysForPersist(
  stateRelays: { url: string; tenantId: string; token: Uint8Array; priority: number }[] | undefined,
  joined: { url: string; tenantId: string; token: Uint8Array }
) {
  const rows = [...(stateRelays ?? [])].sort((a, b) => a.priority - b.priority);
  const match = rows.find(
    (row) => row.url === joined.url && row.tenantId.toLowerCase() === joined.tenantId.toLowerCase()
  );
  if (!match) {
    throw new RelayPasswordJoinError('relay_not_authorized', '该中继不在根签名的中继列表里');
  }
  return rows.map((row, index) => ({
    ...row,
    token:
      row.url === joined.url && row.tenantId.toLowerCase() === joined.tenantId.toLowerCase()
        ? joined.token
        : row.token,
    priority: index,
  }));
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

async function uploadPack(input: {
  relayUrl: string;
  tenantId: string;
  token: Uint8Array;
  rootKey: RootKey;
  kdfParams: KdfParams | null;
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

/** kdf + 加入证明 + 解开密封包。失败时清零已派生的种子，成功则交给编排器在 finally 清零。 */
export async function joinKdfProofAndPack(
  input: JoinTransport & { password: string; now: number }
): Promise<JoinPackPhase> {
  let rootKey: RootKey | undefined;
  try {
    const kdfBody = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(input.relayUrl, `/api/relay/tenants/${input.tenantId}/kdf`),
      label: 'relay tenant kdf',
      timeoutMs: input.timeoutMs,
    });
    const kdfParams = kdfParamsFromWire(kdfBody.kdf_params);
    if (!kdfParams) {
      throw new RelayPasswordJoinError('join_failed', 'relay kdf params are malformed');
    }
    assertKdfParamsWithinBudget(kdfParams);
    rootKey = await deriveRootKey(input.password, kdfParams);
    if (!rootKey) {
      throw new RelayPasswordJoinError('join_failed', 'failed to derive root key');
    }
    const proof = signRelayEnrollProof(rootKey, {
      relayHost: hubHostFromUrl(input.relayUrl),
      ts: input.now,
    });
    const joined = await requestRelayJson({
      fetcher: input.fetcher,
      url: joinRelayUrl(input.relayUrl, '/api/relay/enroll'),
      method: 'POST',
      body: {
        mode: 'join',
        tenant_id: input.tenantId,
        root_public_key: encodeBase64url(rootKey.publicKey),
        root_epoch: typeof kdfBody.root_epoch === 'number' ? kdfBody.root_epoch : 0,
        proof: { bytes: encodeBase64url(proof.bytes), sig: encodeBase64url(proof.sig) },
      },
      label: 'relay password join',
      timeoutMs: input.timeoutMs,
    });
    const rootEpoch = typeof joined.root_epoch === 'number' ? joined.root_epoch : 0;
    if (!joined.sealed_pack || typeof joined.sealed_pack !== 'string') {
      throw new RelayPasswordJoinError('join_failed', 'relay returned no sealed pack');
    }
    const packKdf = kdfParamsFromWire(joined.kdf_params) ?? kdfParams;
    const pack = await openRelayPack({
      rootSeed: rootKey.seed,
      tenantId: input.tenantId,
      rootPublicKey: rootKey.publicKey,
      rootEpoch,
      sealedPack: decodeBase64url(joined.sealed_pack),
    });
    return { rootKey, pack, packKdf, rootEpoch, now: input.now };
  } catch (error) {
    rootKey?.seed.fill(0);
    throw error;
  }
}

/** 下载密钥日志、核对 pack head、回放校验。 */
export async function joinDownloadVerifyReplay(
  transport: JoinTransport,
  pack: JoinPackPhase
): Promise<JoinLogPhase> {
  const records = await downloadKeyLog({
    relayUrl: transport.relayUrl,
    tenantId: transport.tenantId,
    token: pack.pack.token,
    logKey: pack.pack.log_key,
    fetcher: transport.fetcher,
    timeoutMs: transport.timeoutMs,
  });
  pinHead(records, pack.pack.head_seq, pack.pack.head_hash);
  const verified = await verifyKeyLogChain(records, pack.rootKey.publicKey, undefined, {
    verifyPasskeyAssertion: makeReplayPasskeyVerifier(records),
  });
  if (!verified.ok) {
    throw new RelayPasswordJoinError('join_failed', `key log rejected: ${verified.error}`);
  }
  const genesisUid = decodeKeyLogRecord(records[0]?.bytes ?? new Uint8Array()).uid;
  return { records, genesisUid, state: verified.state };
}

function stubKeyService(state: UserKeyState): UserKeyService {
  return { currentState: () => state } as unknown as UserKeyService;
}

async function buildAdmitAndMeta(input: {
  auth: LocalAuthContext;
  pack: JoinPackPhase;
  log: JoinLogPhase;
}): Promise<Awaited<ReturnType<typeof buildSelfAdmitAndMetaKey>> & { nodeId: string }> {
  const identity = await ensureNodeIdentity(input.auth.identityStore);
  const built = await buildSelfAdmitAndMetaKey({
    service: stubKeyService(input.log.state),
    userId: input.log.genesisUid,
    identity,
    rootKey: input.pack.rootKey,
    now: input.pack.now,
  });
  return { ...built, nodeId: identity.nodeIdHex };
}

function mapAppendFailure(result: AppendPairResult, nodeId: string): void {
  if (result.ok) return;
  if (result.kind === 'seq_mismatch') {
    throw new RelayPasswordJoinError('join_failed', 'SEQ_MISMATCH');
  }
  if (result.kind === 'member_ignored') {
    throw new RelayPasswordJoinError('join_failed', 'relay rejected the admit-node member sidecar');
  }
  if (result.kind === 'admit_failed') {
    const message =
      result.error instanceof Error ? result.error.message : 'admit-node append failed';
    throw new RelayPasswordJoinError('join_failed', message);
  }
  const detail = result.error instanceof Error ? result.error.message : 'meta-key append failed';
  throw new RelayPasswordJoinError(
    'join_failed',
    `admit-node was accepted by the relay but meta-key append failed; node ${nodeId} may remain pending on the relay (${detail})`
  );
}

/** 先把 admit-node / meta-key 追加到中继，成功后才提交本机状态。 */
export async function joinSelfAdmitAndPersist(input: {
  auth: LocalAuthContext;
  transport: JoinTransport;
  pack: JoinPackPhase;
  log: JoinLogPhase;
  name?: string;
}): Promise<JoinAdmitPhase> {
  const identity = await ensureNodeIdentity(input.auth.identityStore);
  let log = input.log;
  let built = await buildAdmitAndMeta({ auth: input.auth, pack: input.pack, log });
  let firstLoad = true;
  const remote = await appendAdmitThenMetaRetrying({
    relayUrl: input.transport.relayUrl,
    tenantId: input.transport.tenantId,
    token: input.pack.pack.token,
    logKey: input.pack.pack.log_key,
    fetcher: input.transport.fetcher,
    timeoutMs: input.transport.timeoutMs,
    load: async () => {
      if (!firstLoad) {
        log = await joinDownloadVerifyReplay(input.transport, input.pack);
        built = await buildAdmitAndMeta({ auth: input.auth, pack: input.pack, log });
      }
      firstLoad = false;
      const admit = built.records[0] ?? built.admit;
      const meta = built.records[1] ?? built.admit;
      return {
        admit,
        meta,
        nodeId: built.nodeId,
      };
    },
  });
  mapAppendFailure(remote, remote.nodeId);
  const committed = await joinUserKeyService(input.auth, log.records).commitJoin({
    records: log.records,
    expectedRootPublicKey: input.pack.rootKey.publicKey,
    anchorHash: input.pack.pack.head_hash,
    username: log.genesisUid,
    expectedUserId: log.genesisUid,
    identity: {
      nodeId: identity.nodeIdHex,
      hubUrl: null,
      edPrivateKey: identity.edPrivateKey,
      x25519PrivateKey: identity.x25519PrivateKey,
      certificateJson: JSON.stringify({
        x25519PublicKey: encodeBase64url(identity.x25519PublicKey),
      }),
      certSig: new Uint8Array(0),
      userId: log.genesisUid,
    },
  });
  if (!committed.ok) {
    throw new RelayPasswordJoinError('join_failed', `key log rejected: ${committed.error}`);
  }
  const applied = await input.auth.userKeys.applyMany(log.genesisUid, built.records);
  if (!applied.ok) {
    throw new RelayPasswordJoinError('join_failed', `self-admit failed: ${applied.error}`);
  }
  const state = input.auth.userKeys.currentState(log.genesisUid);
  await persistRelayUplink(input.auth, {
    relays: relaysForPersist(state.relays?.relays, {
      url: input.transport.relayUrl,
      tenantId: input.transport.tenantId,
      token: input.pack.pack.token,
    }),
    logKey: input.pack.pack.log_key,
    metaKey: { epoch: built.metaEpoch, key: built.metaKey },
    name: input.name ?? 'node',
    now: input.pack.now,
  });
  return {
    builtRecords: built.records,
    appliedSeq: applied.seq,
    appliedHash: applied.hash,
    rootEpoch: state.rootEpoch,
    metaKey: built.metaKey,
  };
}

/** 回传自承认记录、上传新 pack、写入 CA pin。 */
export async function joinUploadAndEnv(input: {
  auth: LocalAuthContext;
  transport: JoinTransport;
  pack: JoinPackPhase;
  log: JoinLogPhase;
  admit: JoinAdmitPhase;
  pin: { caPem: string; fingerprint: string } | null;
}): Promise<void> {
  const head = input.auth.keyLogStore.head(input.log.genesisUid);
  await uploadPack({
    relayUrl: input.transport.relayUrl,
    tenantId: input.transport.tenantId,
    token: input.pack.pack.token,
    rootKey: input.pack.rootKey,
    kdfParams: input.pack.packKdf,
    logKey: input.pack.pack.log_key,
    headSeq: head?.seq ?? BigInt(input.admit.appliedSeq),
    headHash: head?.hash ?? input.admit.appliedHash,
    rootEpoch: input.admit.rootEpoch,
    fetcher: input.transport.fetcher,
    timeoutMs: input.transport.timeoutMs,
    now: input.pack.now,
  });
  if (input.pin) {
    storeRelayCaPin(input.auth.db, {
      relayUrl: input.transport.relayUrl,
      caPem: input.pin.caPem,
      fingerprint: input.pin.fingerprint,
    });
  }
}
