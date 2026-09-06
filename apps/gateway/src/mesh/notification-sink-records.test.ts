import { describe, expect, test } from 'bun:test';
import {
  buildKeyLogRecord,
  buildNotificationSinkPayload,
  encodeKeyLogRecord,
  genesisHead,
  hexToBytes,
} from '@tmex/shared/auth';
import { KeyLogStore } from '../auth/key-log-store';
import { createMigratedAuthDb } from '../auth/test-db';
import type { AuthDb } from '../auth/types';
import { UserStore } from '../auth/user-store';
import { projectNotificationSinks } from './notification-sink-records';

const USER = 'user-1';
const NODE_A = 'a'.repeat(32);
const NODE_B = 'b'.repeat(32);

function seedUser(db: AuthDb): void {
  new UserStore(db).create({
    id: USER,
    username: 'owner',
    rootPublicKey: new Uint8Array(32).fill(7),
    rootEpoch: 0,
    kdfParamsJson: '{}',
    keyLogHeadSeq: 0,
    keyLogHeadHash: new Uint8Array(32),
    now: 1_000,
  });
}

function appendSink(
  logs: KeyLogStore,
  seq: number,
  input: { nodeIdHex: string; enabled: boolean; at: number; userId?: string; type?: string }
): void {
  const record = buildKeyLogRecord({ seq: BigInt(seq - 1), hash: new Uint8Array(32) }, 0, {
    uid: USER,
    type: 'notification-sink',
    payload: buildNotificationSinkPayload({
      nodeId: hexToBytes(input.nodeIdHex),
      enabled: input.enabled,
      at: input.at,
    }),
    signer: 'root',
    credential_id: null,
  });
  logs.append({
    userId: input.userId ?? USER,
    seq,
    prevHash: new Uint8Array(32),
    hash: new Uint8Array(32).fill(seq),
    rootEpoch: 0,
    type: input.type ?? 'notification-sink',
    recordBytes: encodeKeyLogRecord(record),
    sig: new Uint8Array(64),
    payloadJson: '{}',
    createdAt: 1_000 + seq,
  });
}

describe('projectNotificationSinks', () => {
  test('回放 notification-sink 记录，最后一条声明为准', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      seedUser(db);
      const logs = new KeyLogStore(db);
      appendSink(logs, 1, { nodeIdHex: NODE_A, enabled: true, at: 1 });
      appendSink(logs, 2, { nodeIdHex: NODE_B, enabled: true, at: 2 });
      appendSink(logs, 3, { nodeIdHex: NODE_A, enabled: false, at: 3 });
      const sinks = projectNotificationSinks(db, USER);
      expect(sinks.get(NODE_A)).toBe(false);
      expect(sinks.get(NODE_B)).toBe(true);
    } finally {
      close();
    }
  });

  test('没有记录时为空集合；`genesisHead` 之外无任何隐含声明', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      seedUser(db);
      expect(genesisHead().seq).toBe(0n);
      expect(projectNotificationSinks(db, USER).size).toBe(0);
    } finally {
      close();
    }
  });

  test('只看本用户的记录，且忽略其它类型', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      seedUser(db);
      const logs = new KeyLogStore(db);
      appendSink(logs, 1, { nodeIdHex: NODE_A, enabled: true, at: 1, type: 'rename-node' });
      expect(projectNotificationSinks(db, USER).size).toBe(0);
      appendSink(logs, 2, { nodeIdHex: NODE_B, enabled: true, at: 2 });
      expect([...projectNotificationSinks(db, 'other-user').keys()]).toEqual([]);
      expect([...projectNotificationSinks(db, USER).keys()]).toEqual([NODE_B]);
    } finally {
      close();
    }
  });
});
