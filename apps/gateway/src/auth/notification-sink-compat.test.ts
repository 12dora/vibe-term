// `notification-sink` 版本门禁：旧节点解不开这条记录（Borsh 枚举 + `user_key_log` 类型
// CHECK），写进去会把它的密钥日志同步卡死。因此**版本未知的已入网成员也要挡**——
// 中继模式下 `peer_cache` 只覆盖握过手的对端，一台离线的老节点在表里根本没有行。

import { describe, expect, test } from 'bun:test';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_NOTIFICATION_SINK_RECORD_VERSION,
  buildKeyLogRecord,
  buildNotificationSinkPayload,
  buildRenameNodePayload,
  encodeKeyLogRecord,
  genesisHead,
  hexToBytes,
} from '@vibeterm/shared/auth';
import { inspectHubAuthRecordCompat } from '../hub/hub-authorization';
import { createMigratedAuthDb } from './test-db';
import { UserStore } from './user-store';

const SELF = 'aa'.repeat(16);
const PEER = 'bb'.repeat(16);
const OFFLINE = 'cc'.repeat(16);

function seedUser(store: UserStore, id = 'user-1'): void {
  store.create({
    id,
    username: 'alice',
    rootPublicKey: new Uint8Array(32),
    rootEpoch: 1,
    kdfParamsJson: '{}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now: 1,
  });
}

function seedCert(store: UserStore, nodeId: string, userId = 'user-1'): void {
  store.upsertCert({
    nodeId,
    userId,
    admitRecordSeq: 1,
    certificateBytes: new Uint8Array(8),
    certSig: new Uint8Array(8),
    authorizationBytes: new Uint8Array(8),
    authorizationSig: new Uint8Array(8),
    revokedLogSeq: null,
  });
}

function seedPeer(store: UserStore, nodeId: string, version: string | null): void {
  store.upsertPeer({
    nodeId,
    name: nodeId,
    endpointsJson: '[]',
    inventoryJson: '{}',
    directCapable: false,
    lastSeenAt: 1,
    listVersion: 1,
    version,
  });
}

function sinkRecord(nodeId = SELF): Uint8Array {
  return encodeKeyLogRecord(
    buildKeyLogRecord(genesisHead(), 0, {
      uid: 'user-1',
      type: 'notification-sink',
      payload: buildNotificationSinkPayload({
        nodeId: hexToBytes(nodeId),
        enabled: true,
        at: 1,
      }),
      signer: 'root',
      credential_id: null,
    })
  );
}

describe('notification-sink 版本门禁', () => {
  test('hub 模式下旧节点被 minVersion 拦截且不允许 force', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      store.createNode({ id: PEER, userId: 'user-1', name: 'old', version: '1.1.38', now: 1 });
      seedCert(store, PEER);
      const blocked = inspectHubAuthRecordCompat(store, sinkRecord(), 'user-1');
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
      expect(blocked.minVersion).toBe(MIN_NOTIFICATION_SINK_RECORD_VERSION);
      expect(blocked.allowForce).toBe(false);
      expect(blocked.nodes).toEqual([{ id: PEER, name: 'old', version: '1.1.38' }]);
    } finally {
      close();
    }
  });

  test('中继模式下版本未知的已入网成员照样挡（fail closed，不因别的对端已缓存而跳过）', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      // 握过手的对端已经是新版本；另一台已入网节点离线，peer_cache 里没有行。
      seedCert(store, PEER);
      seedPeer(store, PEER, MIN_NOTIFICATION_SINK_RECORD_VERSION);
      seedCert(store, OFFLINE);
      const blocked = inspectHubAuthRecordCompat(store, sinkRecord(), 'user-1', {
        relayMode: true,
        localNodeId: SELF,
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe(KEYLOG_TYPE_UNSUPPORTED_BY_NODES);
      expect(blocked.nodes.map((node) => node.id)).toEqual([OFFLINE]);
      expect(blocked.nodes[0]?.version).toBeNull();
    } finally {
      close();
    }
  });

  test('中继模式下全员已缓存且达标才放行；本机不参与判定', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, SELF);
      seedCert(store, PEER);
      seedPeer(store, PEER, MIN_NOTIFICATION_SINK_RECORD_VERSION);
      expect(
        inspectHubAuthRecordCompat(store, sinkRecord(), 'user-1', {
          relayMode: true,
          localNodeId: SELF,
        })
      ).toEqual({ ok: true });
    } finally {
      close();
    }
  });

  test('对照：rename-node 仍按旧策略跳过未缓存成员', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const store = new UserStore(db);
      seedUser(store);
      seedCert(store, PEER);
      seedPeer(store, PEER, '1.1.24');
      seedCert(store, OFFLINE);
      const record = encodeKeyLogRecord(
        buildKeyLogRecord(genesisHead(), 0, {
          uid: 'user-1',
          type: 'rename-node',
          payload: buildRenameNodePayload({ nodeId: hexToBytes(OFFLINE), name: 'a' }),
          signer: 'root',
          credential_id: null,
        })
      );
      expect(
        inspectHubAuthRecordCompat(store, record, 'user-1', { relayMode: true, localNodeId: SELF })
      ).toEqual({ ok: true });
    } finally {
      close();
    }
  });
});
