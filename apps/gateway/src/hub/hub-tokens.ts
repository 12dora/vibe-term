import { encodeBase64url } from '@tmex/shared/auth';
import { decodeBase64url } from '@tmex/shared/auth';
import {
  type HubTokenRow,
  type HubTokensMessage,
  type HubTokensRevision,
  MIN_HUB_TOKENS_VERSION,
} from '@tmex/shared/uplink';
import type { EnrollmentTokenRecord, EnrollmentTokenRevision, UserStore } from '../auth/user-store';
import { nodeVersionSupportsHubAuthRecords } from './hub-authorization';

export const HUB_TOKENS_ACK_WAIT_MS = 2_000;

export function peerSupportsHubTokens(version: string | null | undefined): boolean {
  return nodeVersionSupportsHubAuthRecords(version);
}

export function minHubTokensVersion(): string {
  return MIN_HUB_TOKENS_VERSION;
}

export function tokenRecordToRow(token: EnrollmentTokenRecord): HubTokenRow {
  return {
    id: token.id,
    user_id: token.userId,
    enroll_public_key: encodeBase64url(token.enrollPublicKey),
    authorization_json: token.authorizationJson,
    authorization_sig: encodeBase64url(token.authorizationSig),
    expires_at: token.expiresAt,
    used_at: token.usedAt,
    node_id: token.nodeId,
  };
}

export function tokenRowToRecord(row: HubTokenRow): EnrollmentTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    enrollPublicKey: decodeBase64url(row.enroll_public_key),
    authorizationJson: row.authorization_json,
    authorizationSig: decodeBase64url(row.authorization_sig),
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    nodeId: row.node_id,
  };
}

export function snapshotHubTokensMessage(
  store: UserStore,
  revision: EnrollmentTokenRevision,
  id: string
): HubTokensMessage {
  return {
    t: 'hub.tokens',
    op: 'upsert',
    revision,
    id,
    tokens: store.listEnrollmentTokens().map(tokenRecordToRow),
  };
}

export function upsertHubTokensMessage(
  token: EnrollmentTokenRecord,
  revision: EnrollmentTokenRevision,
  id: string
): HubTokensMessage {
  return {
    t: 'hub.tokens',
    op: 'upsert',
    revision,
    id,
    tokens: [tokenRecordToRow(token)],
  };
}

export function tombstoneHubTokensMessage(
  tokenId: string,
  revision: EnrollmentTokenRevision,
  id: string
): HubTokensMessage {
  return {
    t: 'hub.tokens',
    op: 'tombstone',
    revision,
    id,
    tokens: [
      {
        id: tokenId,
        user_id: '',
        enroll_public_key: encodeBase64url(new Uint8Array(32)),
        authorization_json: '{}',
        authorization_sig: encodeBase64url(new Uint8Array(64)),
        expires_at: 0,
        used_at: null,
        node_id: null,
      },
    ],
  };
}

export function hubTokensAck(msg: HubTokensMessage): HubTokensMessage {
  return {
    t: 'hub.tokens',
    op: msg.op,
    revision: msg.revision,
    id: msg.id,
    ack: true,
  };
}

export function applyHubTokensMessage(
  store: UserStore,
  msg: HubTokensMessage
): 'applied' | 'ignored' {
  const revision: HubTokensRevision = msg.revision;
  if (msg.op === 'tombstone') {
    const id = msg.tokens?.[0]?.id ?? msg.id;
    if (!id) return 'ignored';
    return store.applyEnrollmentTokenReplication({ op: 'tombstone', revision, id });
  }
  let result: 'applied' | 'ignored' = 'ignored';
  for (const row of msg.tokens ?? []) {
    const applied = store.applyEnrollmentTokenReplication({
      op: 'upsert',
      revision,
      token: tokenRowToRecord(row),
    });
    if (applied === 'applied') result = 'applied';
  }
  return result;
}
