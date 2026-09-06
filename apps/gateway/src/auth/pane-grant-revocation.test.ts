// 吊销节点必须连同它的窗格授权一起落库：授权删除挂在提交事务里，
// 单条 apply 与批量 applyMany（对端 key log 同步、中继模式补日志走的都是后者）两条路都要覆盖。

import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  computeRecordHash,
  encodeAdmitNodePayload,
  encodeKeyLogRecord,
  encodeRenameNodePayload,
  encodeRevokeNodePayload,
  type rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '@tmex/shared/auth';
import { agentPaneGrants } from '../db/schema';
import { KeyLogStore } from './key-log-store';
import { ensureNodeIdentity, selfSignedNodeCertificate } from './node-identity-service';
import { NodeIdentityStore } from './node-identity-store';
import { NodeSessionStore } from './node-session-store';
import { createMigratedAuthDb } from './test-db';
import type { AuthDb } from './types';
import { UserKeyService } from './user-key-service';
import { UserStore } from './user-store';

const OTHER_NODE = 'c'.repeat(32);

function createService(db: AuthDb) {
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  return new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
}

function seedGrant(db: AuthDb, id: string, fromNodeId: string): void {
  db.insert(agentPaneGrants)
    .values({
      id,
      tokenHash: 'hash',
      fromNodeId,
      deviceId: 'dev-1',
      paneId: '%1',
      serverEpoch: 'e'.repeat(32),
      createdAt: 1,
      lastUsedAt: 1,
      expiresAt: Date.now() + 86_400_000,
    })
    .run();
}

function grantIds(db: AuthDb): string[] {
  return db
    .select({ id: agentPaneGrants.id })
    .from(agentPaneGrants)
    .all()
    .map((row) => row.id);
}

async function admitSelf(
  db: AuthDb,
  service: UserKeyService,
  boot: { userId: string; rootKey: ReturnType<typeof rootKeyFromSeed>; rootEpoch: number }
) {
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db));
  const admit = await selfSignedNodeCertificate(identity, boot.rootKey, {
    uid: boot.userId,
    rootEpoch: boot.rootEpoch,
    now: Date.now(),
  });
  const applied = await service.signAndApply(boot.userId, boot.rootKey, {
    type: 'admit-node',
    payload: encodeAdmitNodePayload(admit),
  });
  expect(applied.ok).toBe(true);
  return identity;
}

describe('吊销节点时清理窗格授权', () => {
  test('单条 apply：吊销该节点的授权全删，别的节点不受影响', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const service = createService(db);
      const boot = await service.bootstrapUser({ username: 'revoke-single', password: 'pw' });
      const identity = await admitSelf(db, service, boot);
      seedGrant(db, 'g-target-1', identity.nodeIdHex);
      seedGrant(db, 'g-target-2', identity.nodeIdHex);
      seedGrant(db, 'g-other', OTHER_NODE);

      const revoked = await service.signAndApply(boot.userId, boot.rootKey, {
        type: 'revoke-node',
        payload: encodeRevokeNodePayload({ node_id: identity.nodeId, reason: 'lost' }),
      });
      expect(revoked.ok).toBe(true);
      expect(grantIds(db)).toEqual(['g-other']);
    } finally {
      close();
    }
  });

  test('批量 applyMany（对端同步 / 中继补日志）：吊销记录一样清授权', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const service = createService(db);
      const boot = await service.bootstrapUser({ username: 'revoke-batch', password: 'pw' });
      const identity = await admitSelf(db, service, boot);
      seedGrant(db, 'g-batch', identity.nodeIdHex);
      seedGrant(db, 'g-keep', OTHER_NODE);

      // 一批里先来一条无关记录，再来吊销：批量提交的投影必须每条都跑
      let head = service.currentState(boot.userId).head;
      const records: { bytes: Uint8Array; sig: Uint8Array }[] = [];
      for (const payload of [
        { type: 'rename-node' as const, bytes: null },
        { type: 'revoke-node' as const, bytes: null },
      ]) {
        const record = buildKeyLogRecord(head, boot.rootEpoch, {
          uid: boot.userId,
          type: payload.type,
          payload:
            payload.type === 'revoke-node'
              ? encodeRevokeNodePayload({ node_id: identity.nodeId, reason: 'sync' })
              : encodeRenameNodePayload({ node_id: identity.nodeId, name: 'peer' }),
          signer: 'root',
          credential_id: null,
        });
        const bytes = encodeKeyLogRecord(record);
        const sig = signKeyLogRecordWithRoot(boot.rootKey, bytes);
        records.push({ bytes, sig });
        head = { seq: record.seq, hash: computeRecordHash(bytes, sig) };
      }

      const applied = await service.applyMany(boot.userId, records);
      expect(applied.ok).toBe(true);
      expect(grantIds(db)).toEqual(['g-keep']);
    } finally {
      close();
    }
  });

  test('重新 bootstrap（genesis reset-root）删光证书时，窗格授权一并清空', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const service = createService(db);
      const boot = await service.bootstrapUser({ username: 'reset-root', password: 'pw' });
      const identity = await admitSelf(db, service, boot);
      seedGrant(db, 'g-reset', identity.nodeIdHex);
      seedGrant(db, 'g-reset-other', OTHER_NODE);

      await service.bootstrapUser({ username: 'reset-root', password: 'pw2' });
      expect(grantIds(db)).toEqual([]);
    } finally {
      close();
    }
  });
});
