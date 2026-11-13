import type { KdfParams, KeyLogEffect, KeyLogRecord, UserKeyState } from '@vibeterm/shared/auth';
import {
  decodeAddPasskeyPayload,
  decodeAdmitNodePayload,
  decodeBase64url,
  decodeCertificate,
  decodeRemovePasskeyPayload,
  decodeRenameNodePayload,
  decodeRevokeNodePayload,
  decodeRotateRootKeepPayload,
  encodeBase64url,
  nodeIdToHex,
  normalizeNodeName,
} from '@vibeterm/shared/auth';
import { eq } from 'drizzle-orm';
import { deleteAllPaneGrants, deletePaneGrantsForNode } from '../agent/pane-grant/store';
import { nodeIdentity } from '../db/schema';
import { removePortMapsForRevocation } from '../portmap/store';
import { endSharesForRevocation } from '../share/share-store';
import { AccessTokenService } from './access-tokens';
import { toBuffer } from './binary';
import { type KeyLogStore, projectPayloadJson } from './key-log-store';
import { patchNode } from './node-persistence';
import type { NodeSessionStore } from './node-session-store';
import { type PasskeyCounterUpdate, commitPasskeyCounters } from './passkey';
import type { AuthDb } from './types';
import type { UserStore } from './user-store';

const IDENTITY_ROW_ID = 1;

export type AuthStores = {
  db: AuthDb;
  userStore: UserStore;
  keyLogStore: KeyLogStore;
  nodeSessionStore: NodeSessionStore;
  onChange?: () => void;
};

export type AppliedKeyLogStep = {
  input: { bytes: Uint8Array; sig: Uint8Array };
  record: KeyLogRecord;
  hash: Uint8Array;
  next: UserKeyState;
  effects: KeyLogEffect[];
  /** 本条记录验签时得出的 passkey 计数器推进：与记录同一个事务写，记录没落库就不写。 */
  passkeyCounters?: readonly PasskeyCounterUpdate[];
};

export type EncryptedIdentity = {
  nodeId: string;
  privateKey: string;
  x25519PrivateKey: string;
  certificateJson: string;
  certSig: Uint8Array;
  userId: string | null;
};

export function kdfParamsToJson(params: KdfParams): string {
  return JSON.stringify({
    salt: encodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  });
}

export function createTxStores(
  tx: unknown,
  userStore: UserStore,
  keyLogStore: KeyLogStore,
  nodeSessionStore: NodeSessionStore,
  onChange?: () => void
): AuthStores {
  const db = tx as AuthDb;
  return {
    db,
    userStore: new (userStore.constructor as typeof UserStore)(db),
    keyLogStore: new (keyLogStore.constructor as typeof KeyLogStore)(db),
    nodeSessionStore: new (nodeSessionStore.constructor as typeof NodeSessionStore)(db),
    onChange,
  };
}

export function persistEncryptedIdentity(db: AuthDb, identity: EncryptedIdentity): void {
  const row = {
    nodeId: identity.nodeId,
    privateKey: identity.privateKey,
    x25519PrivateKey: identity.x25519PrivateKey,
    certificateJson: identity.certificateJson,
    certSig: toBuffer(identity.certSig),
    userId: identity.userId,
  };
  db.insert(nodeIdentity)
    .values({ id: IDENTITY_ROW_ID, ...row, uplinkKind: 'none' })
    .onConflictDoUpdate({ target: nodeIdentity.id, set: row })
    .run();
}

export function bindIdentityUser(db: AuthDb, userId: string): void {
  db.update(nodeIdentity).set({ userId }).where(eq(nodeIdentity.id, IDENTITY_ROW_ID)).run();
}

export function wipeUserDerivedState(
  userStore: UserStore,
  keyLogStore: KeyLogStore,
  nodeSessionStore: NodeSessionStore,
  userId: string,
  db?: AuthDb
): void {
  // 证书与会话都清了，凭证书说话的窗格授权同样不能留（db 缺省时由调用方保证同库）
  if (db) deleteAllPaneGrants(db);
  keyLogStore.deleteAll(userId);
  userStore.deleteKeysByUser(userId);
  nodeSessionStore.deleteAllForUser(userId);
  userStore.deleteCertsByUser(userId);
  userStore.deleteNodesByUser(userId);
  userStore.deleteEnrollmentTokensByUser(userId);
}

export function persistApplied(
  stores: AuthStores,
  userId: string,
  step: AppliedKeyLogStep,
  now: number,
  onChange?: () => void
): void {
  const { userStore, keyLogStore } = stores;
  const { record, input, hash, effects, next } = step;
  const seq = Number(record.seq);
  keyLogStore.append({
    userId,
    seq,
    prevHash: record.prev_hash,
    hash,
    rootEpoch: record.root_epoch,
    type: record.type,
    recordBytes: input.bytes,
    sig: input.sig,
    payloadJson: projectPayloadJson(record.type, record.payload),
    createdAt: now,
  });
  userStore.updateRoot(userId, {
    rootPublicKey: next.rootPublicKey,
    rootEpoch: next.rootEpoch,
    kdfParamsJson: kdfParamsToJson(next.kdfParams),
    now,
  });
  userStore.setKeyLogHead(userId, { seq: Number(next.head.seq), hash: next.head.hash, now });
  // 计数器推进与记录同生共死：这里是唯一一处写入，事务回滚时它也跟着回滚。
  if (step.passkeyCounters?.length) commitPasskeyCounters(userStore, step.passkeyCounters);
  projectRecord(stores, userId, record, seq, now);
  applyEffects(stores, userId, effects, now);
  if (
    record.type === 'rotate-root' ||
    record.type === 'reset-root' ||
    record.type === 'rotate-root-keep'
  ) {
    userStore.invalidateUnusedEnrollmentTokens(userId, now);
  }
  (onChange ?? stores.onChange)?.();
}

function projectRecord(
  stores: AuthStores,
  userId: string,
  record: KeyLogRecord,
  seq: number,
  now: number
): void {
  const { userStore } = stores;
  if (record.type === 'rotate-root' || record.type === 'reset-root') {
    userStore.deleteKeysByUser(userId);
    userStore.setTotpRecordSeq(userId, null, now);
    if (record.type === 'reset-root') userStore.deleteCertsByUser(userId);
  }
  const byType: Partial<Record<KeyLogRecord['type'], () => void>> = {
    'set-totp': () => userStore.setTotpRecordSeq(userId, seq, now),
    'clear-totp': () => userStore.setTotpRecordSeq(userId, null, now),
    'rotate-root-keep': () => {
      const payload = decodeRotateRootKeepPayload(record.payload);
      if (payload.totp) userStore.setTotpRecordSeq(userId, seq, now);
    },
    'add-passkey': () => {
      const payload = decodeAddPasskeyPayload(record.payload);
      userStore.insertKey({
        id: crypto.randomUUID(),
        userId,
        credentialId: decodeBase64url(payload.credential_id),
        publicKey: payload.public_key,
        rpId: payload.rp_id,
        origin: payload.origin,
        counter: payload.counter,
        transports: payload.transports,
        name: payload.name || null,
        logSeq: seq,
        now,
      });
    },
    'remove-passkey': () => {
      const row = userStore.getKeyByCredentialId(
        decodeBase64url(decodeRemovePasskeyPayload(record.payload).credential_id)
      );
      if (row) userStore.deleteKey(row.id);
    },
    'admit-node': () => persistAdmitNode(stores, userId, record, seq),
    'readmit-node': () => persistReadmitNode(stores, userId, record, seq),
    'revoke-node': () => {
      const hex = nodeIdToHex(decodeRevokeNodePayload(record.payload).node_id);
      userStore.markCertRevoked(hex, seq);
      userStore.deletePeer(hex);
    },
    'rename-node': () => persistRenameNode(stores, record),
  };
  byType[record.type]?.();
}

function persistAdmitNode(
  stores: AuthStores,
  userId: string,
  record: KeyLogRecord,
  seq: number
): void {
  const payload = decodeAdmitNodePayload(record.payload);
  const certificate = decodeCertificate(payload.certificate_bytes);
  stores.userStore.upsertCert({
    nodeId: nodeIdToHex(certificate.node_id),
    userId,
    admitRecordSeq: seq,
    certificateBytes: payload.certificate_bytes,
    certSig: payload.cert_sig,
    authorizationBytes: payload.authorization_bytes,
    authorizationSig: payload.authorization_sig,
    revokedLogSeq: null,
  });
}

function persistReadmitNode(
  stores: AuthStores,
  userId: string,
  record: KeyLogRecord,
  seq: number
): void {
  let payload: ReturnType<typeof decodeAdmitNodePayload>;
  try {
    payload = decodeAdmitNodePayload(record.payload);
  } catch {
    return;
  }
  let certificate: ReturnType<typeof decodeCertificate>;
  try {
    certificate = decodeCertificate(payload.certificate_bytes);
  } catch {
    return;
  }
  const existing = stores.userStore.getCert(nodeIdToHex(certificate.node_id));
  if (!existing || existing.userId !== userId) return;
  stores.userStore.upsertCert({
    nodeId: existing.nodeId,
    userId: existing.userId,
    admitRecordSeq: seq,
    certificateBytes: existing.certificateBytes,
    certSig: existing.certSig,
    authorizationBytes: payload.authorization_bytes,
    authorizationSig: payload.authorization_sig,
    revokedLogSeq: existing.revokedLogSeq,
  });
}

function persistRenameNode(stores: AuthStores, record: KeyLogRecord): void {
  let payload: ReturnType<typeof decodeRenameNodePayload>;
  try {
    payload = decodeRenameNodePayload(record.payload);
  } catch {
    return;
  }
  const name = normalizeNodeName(payload.name);
  if (!name) return;
  const nodeId = nodeIdToHex(payload.node_id);
  patchNode(stores.db, nodeId, { name });
  const peer = stores.userStore.getPeer(nodeId);
  stores.userStore.upsertPeer({
    nodeId,
    name,
    endpointsJson: peer?.endpointsJson ?? '[]',
    inventoryJson: peer?.inventoryJson ?? '{}',
    directCapable: peer?.directCapable ?? false,
    lastSeenAt: peer?.lastSeenAt ?? null,
    listVersion: peer?.listVersion ?? 0,
    version: peer?.version,
  });
  const identity = stores.db
    .select()
    .from(nodeIdentity)
    .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
    .get();
  if (identity?.nodeId === nodeId) {
    stores.db.update(nodeIdentity).set({ name }).where(eq(nodeIdentity.id, IDENTITY_ROW_ID)).run();
  }
}

function applyEffects(
  stores: AuthStores,
  userId: string,
  effects: AppliedKeyLogStep['effects'],
  now: number
): void {
  const { userStore, nodeSessionStore } = stores;
  for (const effect of effects) {
    if (effect.type === 'revokeAllSessions') {
      revokeAllGrants(stores, userId, now);
    } else if (effect.type === 'revokeSessionsByCredential') {
      nodeSessionStore.revokeByCredential(decodeBase64url(effect.credentialId), now);
    } else if (effect.type === 'revokeSessionsVia') {
      revokeGrantsVia(stores, nodeIdToHex(effect.nodeId), now);
    } else if (effect.type === 'clearPeerCache') userStore.deleteAllPeers();
  }
}

/**
 * 改密 / 根密钥轮换 / 重置：会话、访问令牌、窗格授权、终端分享全部作废。
 * 会话与令牌按 `userId` 过滤。`shares` / `agent_pane_grants` 无 owner 列，本节点按单用户
 * 处理：结束全部进行中的分享并删除全部窗格授权（`vibeterm user add` 的第二用户会被连坐）。
 * 库变更在 key log 事务内完成；关分享连接、停端口映射监听、关 exec 会话等运行态拆除
 * 等事务提交后再通知（见 `withKeyLogCommitSideEffects`）。
 */
function revokeAllGrants(stores: AuthStores, userId: string, now: number): void {
  stores.nodeSessionStore.revokeAllForUser(userId, now);
  new AccessTokenService(stores.db, { now: () => now }).revokeAllForUser(userId);
  deleteAllPaneGrants(stores.db);
  endSharesForRevocation(stores.db, {}, now);
}

/**
 * 节点被吊销：经它进来的会话，以及经它签发的令牌、分享、窗格授权（含它自己持有的）、
 * 端口映射与放行全部作废。旧行（0063 之前）记为 `self`，不在此列。
 */
function revokeGrantsVia(stores: AuthStores, nodeId: string, now: number): void {
  stores.nodeSessionStore.revokeVia(nodeId, now);
  new AccessTokenService(stores.db, { now: () => now }).revokeIssuedVia(nodeId);
  deletePaneGrantsForNode(nodeId, stores.db);
  endSharesForRevocation(stores.db, { issuedVia: nodeId }, now);
  removePortMapsForRevocation(stores.db, { issuedVia: nodeId });
}
