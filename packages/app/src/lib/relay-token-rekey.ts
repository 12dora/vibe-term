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
  encodeKeyLogRecord,
  signKeyLogRecordWithRoot,
} from '../../../shared/src/auth';
import type { FetchLike } from './fetch-like';
import { joinUserKeyService } from './keylog-passkey-replay';
import type { LocalAuthContext } from './local-auth';
import { appendOneJoinRecord } from './relay-password-join-append';
import {
  type JoinLogPhase,
  type JoinPackPhase,
  type JoinTransport,
  RelayPasswordJoinError,
} from './relay-password-join-flow';

/**
 * 「只换令牌」（rekey）：本机已经是该租户的成员，但手上那份中继令牌被换发掉了，
 * 又因为连不上中继而拉不到带新令牌的 `set-relays`。这里用账户密码开密封包把令牌取回来。
 *
 * 光改 `mesh_relays` 是不够的：网关下次启动会 `reconcile()` 按**密钥日志投影**整表重写
 * `mesh_relays`，把刚装上的令牌又盖回去。所以必须先把中继上缺的记录追平应用，让投影本身
 * 就带着新令牌；投影里确实没有更新的 `set-relays` 时，就地补签一条。
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

/**
 * 投影里没有更新的 `set-relays` 时补签一条：中继表原样，只把这一条的令牌换成密封包里的那份。
 * 需要当前 `K_meta`（本节点不在当前世代里就封不出来），拿不到时返回 false，由调用方给出提示。
 */
async function publishRekeySetRelays(input: {
  auth: LocalAuthContext;
  secrets: RelaySecrets;
  userId: string;
  transport: JoinTransport;
  pack: JoinPackPhase;
  fetcher?: FetchLike;
}): Promise<boolean> {
  const { auth, secrets, userId, transport, pack } = input;
  const nodes = listRelayNodeKeys(auth.userStore, userId);
  const meta = await secrets.currentMetaKey();
  if (nodes.length === 0 || !meta) return false;
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
  if (!user) return false;
  const record = buildKeyLogRecord(
    { seq: BigInt(user.keyLogHeadSeq), hash: user.keyLogHeadHash },
    user.rootEpoch,
    { uid: userId, type: 'set-relays', payload, signer: 'root', credential_id: null }
  );
  const bytes = encodeKeyLogRecord(record);
  const signed = { bytes, sig: signKeyLogRecordWithRoot(pack.rootKey, bytes) };
  const applied = await auth.userKeys.applyMany(userId, [signed]);
  if (!applied.ok) {
    throw new RelayPasswordJoinError('join_failed', `set-relays rejected: ${applied.error}`);
  }
  // 中继此刻可能还连不上；本机投影已经对了，这条记录由重连后的 catch-up 补推
  await appendOneJoinRecord({
    relayUrl: transport.relayUrl,
    tenantId: transport.tenantId,
    token: pack.pack.token,
    logKey: pack.pack.log_key,
    record: signed,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    ...(transport.timeoutMs !== undefined ? { timeoutMs: transport.timeoutMs } : {}),
  }).catch(() => undefined);
  return true;
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
  const store = new MeshRelayStore(auth.db);
  const stale = (await store.getRelay(transport.relayUrl))?.token ?? new Uint8Array();
  const secrets = relaySecretsFor(auth, userId, identity.nodeIdHex, identity.x25519PrivateKey);
  await secrets.reconcile();
  await store.putSecret('log', RELAY_LOG_KEY_EPOCH, pack.pack.log_key, now);

  const projected = (await store.getRelay(transport.relayUrl))?.token;
  // 追平后的投影已经带来一份新令牌：以它为准，reconcile 从此稳定，不必再签任何记录
  if (projected && !bytesEqual(projected, stale)) return { userId, publishedSetRelays: false };

  const published = await publishRekeySetRelays({
    auth,
    secrets,
    userId,
    transport,
    pack,
    ...(transport.fetcher ? { fetcher: transport.fetcher } : {}),
  });
  await store.setRelayToken({
    url: transport.relayUrl,
    tenantId: transport.tenantId,
    token: pack.pack.token,
    now,
  });
  store.setUplinkKind('relay');
  return { userId, publishedSetRelays: published };
}
