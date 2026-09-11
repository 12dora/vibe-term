import { describe, expect, test } from 'bun:test';
import type { WrapEntry } from '@vibeterm/shared/relay';
import type { NodeCertRecord } from '../auth/user-store';
import { listMetaKeyLagging, metaKeyAdmitCoverage, metaKeyLaggingIds } from './relay-meta-lag';

const EMPTY = new Uint8Array(0);

function cert(nodeId: string, overrides: Partial<NodeCertRecord> = {}): NodeCertRecord {
  return {
    nodeId,
    userId: 'u1',
    admitRecordSeq: 2,
    certificateBytes: EMPTY,
    certSig: EMPTY,
    authorizationBytes: EMPTY,
    authorizationSig: EMPTY,
    revokedLogSeq: null,
    ...overrides,
  };
}

function entry(nodeId: string): WrapEntry {
  return { node_id: nodeId, eph_pk: '', nonce: '', ct: '' };
}

const SELF = '11'.repeat(16);
const OTHER = '22'.repeat(16);
const NEW = '33'.repeat(16);

function run(input: {
  certs: NodeCertRecord[];
  entries: WrapEntry[];
  metaKeyEpoch?: number;
  names?: Record<string, string>;
  createdAt?: Record<string, number>;
}) {
  return listMetaKeyLagging({
    certs: input.certs,
    entries: input.entries,
    metaKeyEpoch: input.metaKeyEpoch ?? 6,
    selfNodeId: SELF,
    nameOf: (id) => input.names?.[id] ?? id,
    createdAtOf: (id) => input.createdAt?.[id] ?? null,
  });
}

describe('listMetaKeyLagging', () => {
  test('当前世代没封给它的成员算欠账，本机与已封的不算', () => {
    const rows = run({
      certs: [cert(SELF), cert(OTHER), cert(NEW, { admitRecordSeq: 9 })],
      entries: [entry(SELF), entry(OTHER)],
    });
    expect(rows).toEqual([{ nodeId: NEW, name: null, since: null, admitSeq: 9 }]);
  });

  test('本机即便不在条目表里也不算（它的密钥来自签发时的 pending 暂存）', () => {
    expect(run({ certs: [cert(SELF)], entries: [] })).toEqual([]);
  });

  test('已吊销的成员不算', () => {
    const rows = run({ certs: [cert(NEW, { revokedLogSeq: 7 })], entries: [] });
    expect(rows).toEqual([]);
  });

  test('还没有租户密钥（epoch 0）时谁都不算落后', () => {
    expect(run({ certs: [cert(NEW)], entries: [], metaKeyEpoch: 0 })).toEqual([]);
  });

  test('显示名等于 node id 时归一成 null——那正是「没送达」的表现', () => {
    const named = run({ certs: [cert(NEW)], entries: [], names: { [NEW]: 'oracle-jp' } });
    expect(named[0]?.name).toBe('oracle-jp');
    const bare = run({ certs: [cert(NEW)], entries: [] });
    expect(bare[0]?.name).toBeNull();
  });

  test('大小写不同的 node id 视为同一台', () => {
    const rows = run({ certs: [cert(NEW)], entries: [entry(NEW.toUpperCase())] });
    expect(rows).toEqual([]);
  });

  test('按 admit seq 排序，id 集合小写归一', () => {
    const rows = run({
      certs: [cert(NEW, { admitRecordSeq: 9 }), cert(OTHER, { admitRecordSeq: 4 })],
      entries: [],
      createdAt: { [OTHER]: 1700 },
    });
    expect(rows.map((row) => row.nodeId)).toEqual([OTHER, NEW]);
    expect(rows[0]?.since).toBe(1700);
    expect([...metaKeyLaggingIds(rows)]).toEqual([OTHER, NEW]);
  });
});

describe('metaKeyAdmitCoverage', () => {
  const projection = { metaKeyEntries: [entry(OTHER)], metaKeyEpoch: 6 };

  test('已被当前世代封到：给幂等空应答，不准备新记录', () => {
    expect(metaKeyAdmitCoverage(projection, OTHER)).toEqual({
      alreadyCovered: true,
      epoch: 6,
      payload: '',
      payloadHash: '',
    });
    expect(metaKeyAdmitCoverage(projection, OTHER.toUpperCase())).not.toBeNull();
  });

  test('没被封到 / 还没有租户密钥：照常换代', () => {
    expect(metaKeyAdmitCoverage(projection, NEW)).toBeNull();
    expect(metaKeyAdmitCoverage({ metaKeyEntries: [], metaKeyEpoch: 0 }, OTHER)).toBeNull();
  });
});
