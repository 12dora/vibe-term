import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@tmex/shared/auth';
import { MIN_HUB_TOKENS_VERSION } from '@tmex/shared/uplink';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import {
  applyHubTokensMessage,
  hubTokensAck,
  peerSupportsHubTokens,
  snapshotHubTokensMessage,
  tokenRecordToRow,
  tombstoneHubTokensMessage,
  upsertHubTokensMessage,
} from './hub-tokens';

const AUTH_SIG = Uint8Array.from({ length: 64 }, () => 3);

function seedUser(store: UserStore): void {
  store.create({
    id: 'user-1',
    username: 'alice',
    rootPublicKey: Uint8Array.from({ length: 32 }, () => 7),
    rootEpoch: 0,
    kdfParamsJson: '{"kdf":"argon2id"}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: Uint8Array.from({ length: 32 }, () => 8),
    now: 1_000,
  });
}

describe('hub-tokens', () => {
  test('版本门控：≥1.1.13（含 _dev 后缀）才发送', () => {
    expect(peerSupportsHubTokens('1.1.13')).toBe(true);
    expect(peerSupportsHubTokens('1.1.13_dev')).toBe(true);
    expect(peerSupportsHubTokens('1.2.0')).toBe(true);
    expect(peerSupportsHubTokens('1.1.12')).toBe(false);
    expect(peerSupportsHubTokens('ver-b')).toBe(false);
    expect(peerSupportsHubTokens(null)).toBe(false);
    expect(peerSupportsHubTokens('')).toBe(false);
    expect(MIN_HUB_TOKENS_VERSION).toBe('1.1.13');
  });

  test('apply snapshot / tombstone / 拒绝未授权由调用方处理', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      const pk = Uint8Array.from({ length: 32 }, () => 11);
      const created = store.createEnrollmentToken({
        id: 'tok-a',
        userId: 'user-1',
        enrollPublicKey: pk,
        authorizationJson: '{"authorization_b64":"x"}',
        authorizationSig: AUTH_SIG,
        expiresAt: 9_000,
      });
      const snap = snapshotHubTokensMessage(store, { epoch: 1, seq: 1 }, 'snap-1');
      expect(snap.tokens).toHaveLength(1);
      expect(snap.tokens?.[0]?.id).toBe('tok-a');
      expect(tokenRecordToRow(created).enroll_public_key).toBe(encodeBase64url(pk));

      const other = createMigratedAuthDb();
      try {
        const standby = new UserStore(other.db);
        seedUser(standby);
        expect(applyHubTokensMessage(standby, snap)).toBe('applied');
        expect(standby.getEnrollmentTokenById('tok-a')?.userId).toBe('user-1');
        const delta = upsertHubTokensMessage(
          { ...created, usedAt: 40, nodeId: 'node-a' },
          { epoch: 1, seq: 2 },
          'up-1'
        );
        expect(applyHubTokensMessage(standby, delta)).toBe('applied');
        expect(standby.getEnrollmentTokenById('tok-a')?.usedAt).toBe(40);
        const tomb = tombstoneHubTokensMessage('tok-a', { epoch: 1, seq: 3 }, 't-1');
        expect(applyHubTokensMessage(standby, tomb)).toBe('applied');
        expect(standby.getEnrollmentTokenById('tok-a')).toBeNull();
        expect(hubTokensAck(delta)).toMatchObject({ ack: true, id: 'up-1', op: 'upsert' });
      } finally {
        other.close();
      }
    } finally {
      close();
    }
  });
});
