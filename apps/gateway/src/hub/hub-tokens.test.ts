import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@tmex/shared/auth';
import { MIN_HUB_TOKENS_VERSION } from '@tmex/shared/uplink';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserStore } from '../auth/user-store';
import { stripEnrollmentReplicationSecrets } from '../auth/user-store';
import {
  HUB_TOKENS_FRAME_MAX_BYTES,
  applyHubTokensMessage,
  assertHubTokensEncodedSize,
  hubTokensAck,
  peerSupportsHubTokens,
  snapshotHubTokensMessage,
  snapshotHubTokensMessages,
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

  test('复制前剥掉 entry_sid / session 元数据，apply 侧同样剥离', () => {
    const raw = JSON.stringify({
      authorization_b64: 'x',
      entry_node_id: 'aa'.repeat(16),
      entry_sid: 'sess-secret',
      callback_url: 'https://evil.example',
      session: { sid: 'nope' },
    });
    const stripped = stripEnrollmentReplicationSecrets(raw);
    expect(stripped).not.toContain('sess-secret');
    expect(stripped).not.toContain('callback');
    expect(stripped).not.toContain('session');
    expect(JSON.parse(stripped)).toMatchObject({
      authorization_b64: 'x',
      entry_node_id: 'aa'.repeat(16),
    });
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      const created = store.createEnrollmentToken({
        id: 'tok-sid',
        userId: 'user-1',
        enrollPublicKey: Uint8Array.from({ length: 32 }, () => 12),
        authorizationJson: raw,
        authorizationSig: AUTH_SIG,
        expiresAt: 9_000,
      });
      expect(tokenRecordToRow(created).authorization_json).not.toContain('sess-secret');
      const other = createMigratedAuthDb();
      try {
        const standby = new UserStore(other.db);
        seedUser(standby);
        const msg = upsertHubTokensMessage(created, { epoch: 1, seq: 1 }, 'u-1');
        expect(msg.tokens?.[0]?.authorization_json).not.toContain('entry_sid');
        expect(applyHubTokensMessage(standby, msg, 'user-1')).toBe('applied');
        const stored = standby.getEnrollmentTokenById('tok-sid');
        expect(stored?.authorizationJson).not.toContain('sess-secret');
        expect(stored?.authorizationJson).toContain('authorization_b64');
      } finally {
        other.close();
      }
    } finally {
      close();
    }
  });

  test('apply 按 user_id 隔离，外用户行忽略', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.create({
        id: 'user-2',
        username: 'bob',
        rootPublicKey: Uint8Array.from({ length: 32 }, () => 9),
        rootEpoch: 0,
        kdfParamsJson: '{"kdf":"argon2id"}',
        keyLogHeadSeq: 0,
        keyLogHeadHash: Uint8Array.from({ length: 32 }, () => 8),
        now: 1_000,
      });
      const pk = Uint8Array.from({ length: 32 }, () => 13);
      const created = store.createEnrollmentToken({
        id: 'tok-other',
        userId: 'user-2',
        enrollPublicKey: pk,
        authorizationJson: '{"authorization_b64":"x"}',
        authorizationSig: AUTH_SIG,
        expiresAt: 9_000,
      });
      const other = createMigratedAuthDb();
      try {
        const standby = new UserStore(other.db);
        seedUser(standby);
        standby.create({
          id: 'user-2',
          username: 'bob',
          rootPublicKey: Uint8Array.from({ length: 32 }, () => 9),
          rootEpoch: 0,
          kdfParamsJson: '{"kdf":"argon2id"}',
          keyLogHeadSeq: 0,
          keyLogHeadHash: Uint8Array.from({ length: 32 }, () => 8),
          now: 1_000,
        });
        const msg = upsertHubTokensMessage(created, { epoch: 1, seq: 1 }, 'u-2');
        expect(applyHubTokensMessage(standby, msg, 'user-1')).toBe('ignored');
        expect(standby.getEnrollmentTokenById('tok-other')).toBeNull();
        expect(applyHubTokensMessage(standby, msg, 'user-2')).toBe('applied');
        expect(standby.getEnrollmentTokenById('tok-other')?.userId).toBe('user-2');
      } finally {
        other.close();
      }
    } finally {
      close();
    }
  });

  test('快照按 ≤48KiB 分页并带 more，编码后校验上限', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      const blob = 'a'.repeat(2 * 1024);
      for (let i = 0; i < 30; i++) {
        store.createEnrollmentToken({
          id: `tok-page-${i}`,
          userId: 'user-1',
          enrollPublicKey: Uint8Array.from({ length: 32 }, (_, j) => (i + j + 1) & 0xff),
          authorizationJson: JSON.stringify({ authorization_b64: blob, pad: blob }),
          authorizationSig: AUTH_SIG,
          expiresAt: 9_000,
        });
      }
      const pages = snapshotHubTokensMessages(store, { epoch: 2, seq: 1 }, 'snap-p', 'user-1');
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.slice(0, -1).every((p) => p.more === true)).toBe(true);
      expect(pages.at(-1)?.more).toBe(false);
      let total = 0;
      for (const page of pages) {
        const encoded = assertHubTokensEncodedSize(page);
        expect(encoded.byteLength).toBeLessThanOrEqual(HUB_TOKENS_FRAME_MAX_BYTES);
        total += page.tokens?.length ?? 0;
      }
      expect(total).toBe(30);
      expect(HUB_TOKENS_FRAME_MAX_BYTES).toBe(48 * 1024);
    } finally {
      close();
    }
  });
});
