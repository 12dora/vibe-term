import type { KdfParams, KeyLogEffect, KeyLogRecord, UserKeyState } from '@tmex/shared/auth';
import {
  decodeAddPasskeyPayload,
  decodeAdmitHubPayload,
  decodeAdmitNodePayload,
  decodeBase64url,
  decodeCertificate,
  decodeRemovePasskeyPayload,
  decodeRetireHubPayload,
  decodeRevokeNodePayload,
  decodeRotateRootKeepPayload,
  encodeBase64url,
  nodeIdToHex,
} from '@tmex/shared/auth';
import { eq } from 'drizzle-orm';
import { nodeIdentity } from '../db/schema';
import { toBuffer } from './binary';
import { type KeyLogStore, projectPayloadJson } from './key-log-store';
import type { NodeSessionStore } from './node-session-store';
import type { AuthDb } from './types';
import type { UserStore } from './user-store';

const IDENTITY_ROW_ID = 1;

export type AuthStores = {
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
};

export type EncryptedIdentity = {
  nodeId: string;
  hubUrl: string | null;
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
    userStore: new (userStore.constructor as typeof UserStore)(db),
    keyLogStore: new (keyLogStore.constructor as typeof KeyLogStore)(db),
    nodeSessionStore: new (nodeSessionStore.constructor as typeof NodeSessionStore)(db),
    onChange,
  };
}

export function persistEncryptedIdentity(db: AuthDb, identity: EncryptedIdentity): void {
  const row = {
    nodeId: identity.nodeId,
    hubUrl: identity.hubUrl,
    privateKey: identity.privateKey,
    x25519PrivateKey: identity.x25519PrivateKey,
    certificateJson: identity.certificateJson,
    certSig: toBuffer(identity.certSig),
    userId: identity.userId,
  };
  db.insert(nodeIdentity)
    .values({ id: IDENTITY_ROW_ID, ...row })
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
  userId: string
): void {
  keyLogStore.deleteAll(userId);
  userStore.deleteKeysByUser(userId);
  nodeSessionStore.deleteAllForUser(userId);
  userStore.deleteCertsByUser(userId);
  userStore.deleteHubAuthorizationsByUser(userId);
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
  projectRecord(userStore, userId, record, seq, now);
  applyEffects(stores, userId, effects, now);
  (onChange ?? stores.onChange)?.();
}

function projectRecord(
  userStore: UserStore,
  userId: string,
  record: KeyLogRecord,
  seq: number,
  now: number
): void {
  if (record.type === 'rotate-root' || record.type === 'reset-root') {
    userStore.deleteKeysByUser(userId);
    userStore.setTotpRecordSeq(userId, null, now);
    if (record.type === 'reset-root') {
      userStore.deleteCertsByUser(userId);
      userStore.deleteHubAuthorizationsByUser(userId);
    }
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
    'admit-node': () => {
      const payload = decodeAdmitNodePayload(record.payload);
      const certificate = decodeCertificate(payload.certificate_bytes);
      userStore.upsertCert({
        nodeId: nodeIdToHex(certificate.node_id),
        userId,
        admitRecordSeq: seq,
        certificateBytes: payload.certificate_bytes,
        certSig: payload.cert_sig,
        authorizationBytes: payload.authorization_bytes,
        authorizationSig: payload.authorization_sig,
        revokedLogSeq: null,
      });
    },
    'revoke-node': () => {
      const hex = nodeIdToHex(decodeRevokeNodePayload(record.payload).node_id);
      userStore.markCertRevoked(hex, seq);
      userStore.deletePeer(hex);
      const existing = userStore.getHubAuthorization(userId, hex);
      if (existing) {
        userStore.upsertHubAuthorization({
          userId,
          hubNodeId: hex,
          status: 'retired',
          publicUrl: existing.publicUrl,
          priority: existing.priority,
          admitSeq: existing.admitSeq,
          retireSeq: seq,
          updatedSeq: seq,
        });
      }
    },
    'admit-hub': () => {
      const payload = decodeAdmitHubPayload(record.payload);
      const hex = nodeIdToHex(payload.hub_node_id);
      const existing = userStore.getHubAuthorization(userId, hex);
      userStore.upsertHubAuthorization({
        userId,
        hubNodeId: hex,
        status: 'active',
        publicUrl: payload.public_url ?? existing?.publicUrl ?? null,
        priority: payload.priority ?? existing?.priority ?? null,
        admitSeq: seq,
        retireSeq: null,
        updatedSeq: seq,
      });
    },
    'retire-hub': () => {
      const hex = nodeIdToHex(decodeRetireHubPayload(record.payload).hub_node_id);
      const existing = userStore.getHubAuthorization(userId, hex);
      if (!existing) return;
      userStore.upsertHubAuthorization({
        userId,
        hubNodeId: hex,
        status: 'retired',
        publicUrl: existing.publicUrl,
        priority: existing.priority,
        admitSeq: existing.admitSeq,
        retireSeq: seq,
        updatedSeq: seq,
      });
    },
  };
  byType[record.type]?.();
}

function applyEffects(
  stores: AuthStores,
  userId: string,
  effects: AppliedKeyLogStep['effects'],
  now: number
): void {
  const { userStore, nodeSessionStore } = stores;
  for (const effect of effects) {
    if (effect.type === 'revokeAllSessions') nodeSessionStore.revokeAllForUser(userId, now);
    else if (effect.type === 'revokeSessionsByCredential') {
      nodeSessionStore.revokeByCredential(decodeBase64url(effect.credentialId), now);
    } else if (effect.type === 'revokeSessionsVia') {
      nodeSessionStore.revokeVia(nodeIdToHex(effect.nodeId), now);
    } else if (effect.type === 'clearPeerCache') userStore.deleteAllPeers();
  }
}
