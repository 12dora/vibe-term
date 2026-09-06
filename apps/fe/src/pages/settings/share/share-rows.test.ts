// 跨节点汇总的摊平：行要带上自己的节点，单台节点拉挂了其余节点照常出。

import { describe, expect, test } from 'bun:test';
import type { ShareRecord } from '@vibeterm/shared/share';
import {
  type ShareListResult,
  failedShareNodeNames,
  flattenActiveShares,
  shareRowKey,
  toShareRows,
} from './share-rows';

const NOW = 1_700_000_000_000;

function record(patch: Partial<ShareRecord> = {}): ShareRecord {
  return {
    id: 'sh1',
    name: 'demo',
    deviceId: 'dev1',
    windowId: '@1',
    windowName: 'build',
    state: 'active',
    endReason: null,
    createdAt: NOW - 1000,
    expiresAt: null,
    endedAt: null,
    origin: 'https://vibeterm.example.com',
    url: 'https://vibeterm.example.com/s/sh1',
    viewers: 0,
    logBytes: 0,
    logTruncated: false,
    recordLog: true,
    ...patch,
  };
}

const NODES = [
  { id: 'self', name: '本机' },
  { id: 'node-b', name: 'studio' },
];

function listed(active: ShareRecord[]): ShareListResult {
  return { data: { active, history: [] } };
}

describe('flattenActiveShares', () => {
  test('两台节点的列表并成一张表，每行带上自己的节点', () => {
    const rows = flattenActiveShares(NODES, [
      listed([record()]),
      listed([record({ id: 'sh2' }), record({ id: 'sh3' })]),
    ]);
    expect(rows.map((row) => [row.id, row.nodeId, row.nodeName])).toEqual([
      ['sh1', 'self', '本机'],
      ['sh2', 'node-b', 'studio'],
      ['sh3', 'node-b', 'studio'],
    ]);
  });

  test('一台节点拉挂了不影响其余节点的行', () => {
    const rows = flattenActiveShares(NODES, [{ isError: true }, listed([record({ id: 'sh2' })])]);
    expect(rows.map((row) => row.id)).toEqual(['sh2']);
    expect(failedShareNodeNames(NODES, [{ isError: true }, listed([])])).toEqual(['本机']);
  });

  test('全部就位时没有失败节点', () => {
    expect(failedShareNodeNames(NODES, [listed([]), listed([])])).toEqual([]);
  });

  test('还没返回的节点既不出行也不算失败', () => {
    expect(flattenActiveShares(NODES, [{}, {}])).toEqual([]);
    expect(failedShareNodeNames(NODES, [{}, {}])).toEqual([]);
  });
});

describe('shareRowKey', () => {
  test('同 id 不同节点是两行', () => {
    expect(shareRowKey({ nodeId: 'self', id: 'sh1' })).not.toBe(
      shareRowKey({ nodeId: 'node-b', id: 'sh1' })
    );
  });

  test('toShareRows 原样保留记录字段', () => {
    const [row] = toShareRows(NODES[1], [record({ viewers: 3 })]);
    expect(row.viewers).toBe(3);
    expect(row.nodeId).toBe('node-b');
  });
});
