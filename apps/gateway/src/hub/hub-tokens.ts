import { encodeBase64url } from '@tmex/shared/auth';
import { decodeBase64url } from '@tmex/shared/auth';
import {
  type HubTokenRow,
  type HubTokensMessage,
  type HubTokensRevision,
  MIN_HUB_TOKENS_VERSION,
  UPLINK_CTL_MAX_BYTES,
  encodeHubUplinkCtl,
} from '@tmex/shared/uplink';
import type { EnrollmentTokenRecord, EnrollmentTokenRevision, UserStore } from '../auth/user-store';
import { stripEnrollmentReplicationSecrets } from '../auth/user-store';
import { nodeVersionSupportsHubAuthRecords } from './hub-authorization';

export const HUB_TOKENS_ACK_WAIT_MS = 2_000;
export const HUB_TOKENS_FRAME_MAX_BYTES = 48 * 1024;

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
    authorization_json: stripEnrollmentReplicationSecrets(token.authorizationJson),
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
    authorizationJson: stripEnrollmentReplicationSecrets(row.authorization_json),
    authorizationSig: decodeBase64url(row.authorization_sig),
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    nodeId: row.node_id,
  };
}

export function assertHubTokensEncodedSize(msg: HubTokensMessage): Uint8Array {
  const encoded = encodeHubUplinkCtl(msg);
  if (encoded.byteLength > HUB_TOKENS_FRAME_MAX_BYTES) {
    throw new Error(
      `hub.tokens frame ${encoded.byteLength} exceeds ${HUB_TOKENS_FRAME_MAX_BYTES} (hard ${UPLINK_CTL_MAX_BYTES})`
    );
  }
  return encoded;
}

export function snapshotHubTokensMessages(
  store: UserStore,
  revision: EnrollmentTokenRevision,
  id: string,
  userId?: string
): HubTokensMessage[] {
  const rows = store
    .listEnrollmentTokens(userId)
    .map(tokenRecordToRow)
    .filter((row) => !userId || row.user_id === userId);
  if (rows.length === 0) {
    const empty: HubTokensMessage = {
      t: 'hub.tokens',
      op: 'upsert',
      revision,
      id,
      tokens: [],
      more: false,
    };
    assertHubTokensEncodedSize(empty);
    return [empty];
  }
  const pages: HubTokensMessage[] = [];
  let batch: HubTokenRow[] = [];
  const fits = (tokens: HubTokenRow[], more: boolean): boolean => {
    try {
      assertHubTokensEncodedSize({
        t: 'hub.tokens',
        op: 'upsert',
        revision,
        id,
        tokens,
        more,
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const row of rows) {
    const next = [...batch, row];
    if (batch.length > 0 && !fits(next, true)) {
      pages.push({
        t: 'hub.tokens',
        op: 'upsert',
        revision,
        id,
        tokens: batch,
        more: true,
      });
      batch = [row];
      if (!fits(batch, true)) {
        console.warn(`[hub] hub.tokens skip oversized token id=${row.id}`);
        batch = [];
      }
    } else if (batch.length === 0 && !fits(next, true) && !fits(next, false)) {
      console.warn(`[hub] hub.tokens skip oversized token id=${row.id}`);
    } else {
      batch = next;
    }
  }
  if (batch.length > 0 || pages.length === 0) {
    pages.push({
      t: 'hub.tokens',
      op: 'upsert',
      revision,
      id,
      tokens: batch,
      more: false,
    });
  } else {
    const last = pages[pages.length - 1];
    if (last) last.more = false;
  }
  for (const page of pages) assertHubTokensEncodedSize(page);
  return pages;
}

export function snapshotHubTokensMessage(
  store: UserStore,
  revision: EnrollmentTokenRevision,
  id: string,
  userId?: string
): HubTokensMessage {
  const pages = snapshotHubTokensMessages(store, revision, id, userId);
  return (
    pages[0] ?? {
      t: 'hub.tokens',
      op: 'upsert',
      revision,
      id,
      tokens: [],
      more: false,
    }
  );
}

export function upsertHubTokensMessage(
  token: EnrollmentTokenRecord,
  revision: EnrollmentTokenRevision,
  id: string
): HubTokensMessage {
  const msg: HubTokensMessage = {
    t: 'hub.tokens',
    op: 'upsert',
    revision,
    id,
    tokens: [tokenRecordToRow(token)],
    more: false,
  };
  assertHubTokensEncodedSize(msg);
  return msg;
}

export function tombstoneHubTokensMessage(
  tokenId: string,
  revision: EnrollmentTokenRevision,
  id: string
): HubTokensMessage {
  const msg: HubTokensMessage = {
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
    more: false,
  };
  assertHubTokensEncodedSize(msg);
  return msg;
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
  msg: HubTokensMessage,
  userId?: string
): 'applied' | 'ignored' {
  const revision: HubTokensRevision = msg.revision;
  if (msg.op === 'tombstone') {
    const id = msg.tokens?.[0]?.id ?? msg.id;
    if (!id) return 'ignored';
    if (userId) {
      const existing = store.getEnrollmentTokenById(id);
      if (existing && existing.userId !== userId) return 'ignored';
    }
    return store.applyEnrollmentTokenReplication({ op: 'tombstone', revision, id });
  }
  let result: 'applied' | 'ignored' = 'ignored';
  for (const row of msg.tokens ?? []) {
    if (userId && row.user_id !== userId) continue;
    const applied = store.applyEnrollmentTokenReplication({
      op: 'upsert',
      revision,
      token: tokenRowToRecord(row),
    });
    if (applied === 'applied') result = 'applied';
  }
  return result;
}
