import {
  MeshRelayStore,
  RELAY_LOG_KEY_EPOCH,
} from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import {
  buildSetRelaysPayload,
  listRelayNodeKeys,
  mergeRelayTargets,
} from '../../../../apps/gateway/src/mesh/relay-payloads';
import { RelaySecrets } from '../../../../apps/gateway/src/mesh/relay-secrets';
import {
  buildKeyLogRecord,
  bytesEqual,
  computeRecordHash,
  decodeKeyLogRecord,
  encodeKeyLogRecord,
  signKeyLogRecordWithRoot,
} from '../../../shared/src/auth';
import { findWrapEntry, unwrapKeyForNode } from '../../../shared/src/relay';
import { joinUserKeyService } from './keylog-passkey-replay';
import type { LocalAuthContext } from './local-auth';
import { appendOneJoinRecord, isRelaySeqMismatch } from './relay-password-join-append';
import {
  type JoinLogPhase,
  type JoinPackPhase,
  type JoinTransport,
  RelayPasswordJoinError,
  joinDownloadVerifyReplay,
} from './relay-password-join-flow';

/**
 * 「只换令牌」（rekey）：本机已经是该租户的成员，但手上那份中继令牌被换发掉了，
 * 又因为连不上中继而拉不到带新令牌的 `set-relays`。这里用账户密码开密封包把令牌取回来。
 *
 * 光改 `mesh_relays` 是不够的：网关下次启动会 `reconcile()` 按**密钥日志投影**整表重写
 * `mesh_relays`，把刚装上的令牌又盖回去。所以必须先把中继上缺的记录追平应用，让投影本身
 * 就带着新令牌；投影不够新时，就地用密封包里的令牌补签一条（先中继后本机，不留分叉）。
 * 补签不成一律显式报错——半成功会在下一次 reconcile 时静默退回旧令牌。
 */

function localHeadPrefixMatches(
  auth: LocalAuthContext,
  userId: string,
  records: readonly { bytes: Uint8Array; sig: Uint8Array }[]
): boolean {
  const user = auth.userStore.getById(userId);
  if (!user) return false;
  const head = user.keyLogHeadSeq;
  if (head === 0) return true;
  const at = records[head - 1];
  if (!at) return false;
  return bytesEqual(computeRecordHash(at.bytes, at.sig), user.keyLogHeadHash);
}

/**
 * 同账户判定走**密钥日志**而不是根公钥：漏掉一次 `rotate-root-keep` 的成员本地根公钥会和
 * 密封包里的对不上，但它仍是同一个账户——链的 genesis uid 相同，且本地 head 是这条链的前缀。
 */
export function assertRekeyAccount(
  auth: LocalAuthContext,
  userId: string,
  log: JoinLogPhase
): void {
  if (log.genesisUid !== userId) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'this machine belongs to a different mesh account; password join refuses to overwrite it'
    );
  }
  if (!localHeadPrefixMatches(auth, userId, log.records)) {
    throw new RelayPasswordJoinError(
      'local_user_exists',
      'the local key log is not a prefix of the relay key log; refusing to re-key'
    );
  }
}

/** 追平本地缺的记录（含错过的 `rotate-root-keep`），投影据此跟上当前根与中继表。 */
async function applyMissingRecords(
  auth: LocalAuthContext,
  userId: string,
  log: JoinLogPhase
): Promise<void> {
  const head = auth.userStore.getById(userId)?.keyLogHeadSeq ?? 0;
  const missing = log.records.slice(head);
  if (missing.length === 0) return;
  const applied = await joinUserKeyService(auth, log.records).applyMany(userId, missing);
  if (!applied.ok) {
    throw new RelayPasswordJoinError('join_failed', `key log catch-up failed: ${applied.error}`);
  }
}

function relaySecretsFor(
  auth: LocalAuthContext,
  userId: string,
  nodeIdHex: string,
  sk: Uint8Array
) {
  return new RelaySecrets({
    db: auth.db,
    identity: { nodeIdHex, x25519PrivateKey: sk },
    userIdOf: () => userId,
  });
}

/** 日志里最新一条 `set-relays` 的 seq；一条都没有时为 0。 */
function newestSetRelaysSeq(records: readonly { bytes: Uint8Array }[]): bigint {
  let newest = 0n;
  for (const row of records) {
    try {
      const record = decodeKeyLogRecord(row.bytes);
      if (record.type === 'set-relays' && record.seq > newest) newest = record.seq;
    } catch {
      // 追平时已经逐条验过签；这里只是找最新那条，坏记录跳过即可
    }
  }
  return newest;
}

/**
 * 投影里那条 `set-relays` 是否**确实比密封包新**。
 *
 * 只比「令牌和之前不一样」是不够的：本机手上是 T0、日志里只有更早那次换发留下的 T1、
 * 而密封包里是从未发布过 `set-relays` 的 T2 时，令牌确实变了，采用的却仍是过期的 T1。
 * 密封包钉住了封装时的日志头（`head_seq`），因此只有 seq 严格更大的 `set-relays` 才算更新。
 */
function projectionIsFresherThanPack(records: readonly { bytes: Uint8Array }[], headSeq: bigint) {
  return newestSetRelaysSeq(records) > headSeq;
}

type RekeyRecord = { bytes: Uint8Array; sig: Uint8Array };

/**
 * 当前世代的 `K_meta`，**只读**：先看 `mesh_secrets`，没有再从投影里那条属于本节点的封装解。
 *
 * 不走 `RelaySecrets.reconcile()` 是因为它同时会按投影整表重写 `mesh_relays`；补签失败时
 * 本机就只剩一份被投影改写过的状态，等于半成功。这里全程不写库。
 */
async function currentMetaKeyReadOnly(
  secrets: RelaySecrets,
  identity: { nodeIdHex: string; x25519PrivateKey: Uint8Array }
): Promise<{ key: Uint8Array; epoch: number } | null> {
  const projection = secrets.projection();
  const epoch = projection.metaKeyEpoch;
  if (epoch <= 0) return null;
  const stored = await secrets.metaKey(epoch);
  if (stored) return { key: stored, epoch };
  const entry = findWrapEntry(projection.metaKeyEntries, identity.nodeIdHex);
  if (!entry) return null;
  try {
    const key = await unwrapKeyForNode({ entry, nodeX25519Sk: identity.x25519PrivateKey });
    return { key, epoch };
  } catch {
    return null;
  }
}

/** 用密封包里的令牌重签一条 `set-relays`；缺 `K_meta` / 没有可封装的节点一律显式报错。 */
async function buildRekeySetRelays(input: {
  auth: LocalAuthContext;
  secrets: RelaySecrets;
  identity: { nodeIdHex: string; x25519PrivateKey: Uint8Array };
  userId: string;
  transport: JoinTransport;
  pack: JoinPackPhase;
}): Promise<RekeyRecord> {
  const { auth, secrets, userId, transport, pack } = input;
  const nodes = listRelayNodeKeys(auth.userStore, userId);
  if (nodes.length === 0) {
    throw new RelayPasswordJoinError('join_failed', 'no admitted nodes to wrap the relay keys for');
  }
  const meta = await currentMetaKeyReadOnly(secrets, input.identity);
  if (!meta) {
    throw new RelayPasswordJoinError(
      'relay_key_missing',
      'this node is not addressed by the current meta key; ask an active node to run `vibeterm relay resend-token`'
    );
  }
  const relays = mergeRelayTargets(secrets.projection().relays, {
    url: transport.relayUrl,
    tenantId: transport.tenantId,
    token: pack.pack.token,
    priority: 0,
  });
  const payload = await buildSetRelaysPayload({
    relays,
    logKey: pack.pack.log_key,
    metaKey: meta.key,
    metaEpoch: meta.epoch,
    nodes,
  });
  const user = auth.userStore.getById(userId);
  if (!user) throw new RelayPasswordJoinError('join_failed', 'local user vanished mid-rekey');
  const bytes = encodeKeyLogRecord(
    buildKeyLogRecord(
      { seq: BigInt(user.keyLogHeadSeq), hash: user.keyLogHeadHash },
      user.rootEpoch,
      { uid: userId, type: 'set-relays', payload, signer: 'root', credential_id: null }
    )
  );
  return { bytes, sig: signKeyLogRecordWithRoot(pack.rootKey, bytes) };
}

/** 中继先落账再本机落账：反过来的话中继一 `SEQ_MISMATCH`，本地就永久分叉。 */
async function appendToRelay(
  transport: JoinTransport,
  pack: JoinPackPhase,
  record: RekeyRecord
): Promise<'ok' | 'seq_mismatch'> {
  try {
    await appendOneJoinRecord({
      relayUrl: transport.relayUrl,
      tenantId: transport.tenantId,
      token: pack.pack.token,
      logKey: pack.pack.log_key,
      record,
      ...(transport.fetcher ? { fetcher: transport.fetcher } : {}),
      ...(transport.timeoutMs !== undefined ? { timeoutMs: transport.timeoutMs } : {}),
    });
    return 'ok';
  } catch (error) {
    if (isRelaySeqMismatch(error)) return 'seq_mismatch';
    throw new RelayPasswordJoinError(
      'join_failed',
      `set-relays append failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

const REKEY_APPEND_ATTEMPTS = 3;

/**
 * 让本机投影落到「当前令牌」上：投影本身够新就直接用它，否则用密封包里的令牌补签一条
 * `set-relays`——先追加到中继，成功了才本机落账。并发冲突（`SEQ_MISMATCH`）时重新下载、
 * 校验、重新派生并重签，最多 `REKEY_APPEND_ATTEMPTS` 轮，仍不成则显式报错。
 */
async function ensureCurrentRelayToken(input: {
  auth: LocalAuthContext;
  secrets: RelaySecrets;
  identity: { nodeIdHex: string; x25519PrivateKey: Uint8Array };
  userId: string;
  transport: JoinTransport;
  pack: JoinPackPhase;
  log: JoinLogPhase;
}): Promise<boolean> {
  const { auth, secrets, identity, userId, transport, pack } = input;
  let log = input.log;
  for (let attempt = 0; attempt < REKEY_APPEND_ATTEMPTS; attempt++) {
    if (projectionIsFresherThanPack(log.records, pack.pack.head_seq)) {
      await secrets.reconcile();
      return false;
    }
    const record = await buildRekeySetRelays({
      auth,
      secrets,
      identity,
      userId,
      transport,
      pack,
    });
    const appended = await appendToRelay(transport, pack, record);
    if (appended === 'seq_mismatch') {
      log = await joinDownloadVerifyReplay(transport, pack);
      assertRekeyAccount(auth, userId, log);
      await applyMissingRecords(auth, userId, log);
      continue;
    }
    const applied = await auth.userKeys.applyMany(userId, [record]);
    if (!applied.ok) {
      throw new RelayPasswordJoinError('join_failed', `set-relays rejected: ${applied.error}`);
    }
    await secrets.reconcile();
    return true;
  }
  throw new RelayPasswordJoinError(
    'join_failed',
    'the relay key log kept moving under the re-key; retry once the tenant is idle'
  );
}

export type RelayRekeyResult = { userId: string; publishedSetRelays: boolean };

export async function rekeyRelayToken(input: {
  auth: LocalAuthContext;
  transport: JoinTransport;
  pack: JoinPackPhase;
  log: JoinLogPhase;
  userId: string;
  now: number;
}): Promise<RelayRekeyResult> {
  const { auth, transport, pack, log, userId, now } = input;
  assertRekeyAccount(auth, userId, log);
  await applyMissingRecords(auth, userId, log);
  const identity = await ensureNodeIdentity(auth.identityStore);
  const secrets = relaySecretsFor(auth, userId, identity.nodeIdHex, identity.x25519PrivateKey);
  const published = await ensureCurrentRelayToken({
    auth,
    secrets,
    identity: { nodeIdHex: identity.nodeIdHex, x25519PrivateKey: identity.x25519PrivateKey },
    userId,
    transport,
    pack,
    log,
  });
  const store = new MeshRelayStore(auth.db);
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, pack.pack.log_key, now);
  store.setUplinkKind('relay');
  const stored = await store.getRelay(transport.relayUrl);
  if (!stored) {
    throw new RelayPasswordJoinError(
      'join_failed',
      'the key log holds no relay target for this url'
    );
  }
  return { userId, publishedSetRelays: published };
}
