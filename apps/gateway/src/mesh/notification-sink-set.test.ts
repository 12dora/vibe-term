import { describe, expect, test } from 'bun:test';
import { type SinkSetInput, collectMeshNotificationSinks } from './notification-sink-set';

function input(overrides: Partial<SinkSetInput> = {}): SinkSetInput {
  return {
    selfNodeId: 'aa',
    selfName: '本机',
    selfEnabled: false,
    listed: [],
    certs: [],
    peers: [],
    nodes: [],
    reach: new Map(),
    hubOnline: new Set(),
    ...overrides,
  };
}

describe('collectMeshNotificationSinks', () => {
  test('本机开关打开时本机进集合并标 self/online', () => {
    const sinks = collectMeshNotificationSinks(input({ selfEnabled: true }));
    expect(sinks).toEqual([{ nodeId: 'aa', name: '本机', self: true, online: true }]);
  });

  test('本机关着就不在集合里', () => {
    expect(collectMeshNotificationSinks(input())).toEqual([]);
  });

  test('从 node.list 广播的 inventory 识别远端汇聚机', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        listed: [{ id: 'bb', name: 'B', inventory: { version: '1.1.36', notifySink: true } }],
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        hubOnline: new Set(['bb']),
      })
    );
    expect(sinks).toEqual([{ nodeId: 'bb', name: 'B', self: false, online: true }]);
  });

  test('从 peer_cache 的 inventoryJson 识别（直连对端状态）', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        peers: [{ nodeId: 'bb', name: 'B-peer', inventoryJson: '{"notifySink":true}' }],
        reach: new Map([['bb', 'lan']]),
      })
    );
    expect(sinks).toEqual([{ nodeId: 'bb', name: 'B-peer', self: false, online: true }]);
  });

  test('hub 侧从 nodes 行的 inventoryJson 识别，离线也保留', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        nodes: [{ id: 'bb', name: 'B-node', inventoryJson: '{"notifySink":true}' }],
      })
    );
    expect(sinks).toEqual([{ nodeId: 'bb', name: 'B-node', self: false, online: false }]);
  });

  test('inventory 没有标记 / 坏 JSON 一律不算汇聚机', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        certs: [
          { nodeId: 'bb', revokedLogSeq: null },
          { nodeId: 'cc', revokedLogSeq: null },
        ],
        peers: [
          { nodeId: 'bb', name: 'B', inventoryJson: '{"version":"1.1.36"}' },
          { nodeId: 'cc', name: 'C', inventoryJson: 'not json' },
        ],
      })
    );
    expect(sinks).toEqual([]);
  });

  test('已吊销的证书不进集合', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        certs: [{ nodeId: 'bb', revokedLogSeq: 12 }],
        peers: [{ nodeId: 'bb', name: 'B', inventoryJson: '{"notifySink":true}' }],
      })
    );
    expect(sinks).toEqual([]);
  });

  test('本机排在最前，其余按名字排序', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        selfEnabled: true,
        certs: [
          { nodeId: 'bb', revokedLogSeq: null },
          { nodeId: 'cc', revokedLogSeq: null },
        ],
        peers: [
          { nodeId: 'cc', name: 'Alpha', inventoryJson: '{"notifySink":true}' },
          { nodeId: 'bb', name: 'Zulu', inventoryJson: '{"notifySink":true}' },
        ],
      })
    );
    expect(sinks.map((s) => s.name)).toEqual(['本机', 'Alpha', 'Zulu']);
  });

  test('上行中断后对端直接撤销：peer 行为准，node.list 的陈旧声明不再算数', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        listed: [{ id: 'bb', name: 'B', inventory: { notifySink: true } }],
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        peers: [
          { nodeId: 'bb', name: 'B', inventoryJson: '{"version":"1.1.36"}', lastSeenAt: 2_000 },
        ],
        reach: new Map([['bb', 'lan']]),
      })
    );
    expect(sinks).toEqual([]);
  });

  test('peer 行比 nodes 行新时以 peer 行为准（直连撤销先到）', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        peers: [{ nodeId: 'bb', name: 'B', inventoryJson: '{}', lastSeenAt: 3_000 }],
        nodes: [{ id: 'bb', name: 'B', inventoryJson: '{"notifySink":true}', lastSeenAt: 1_000 }],
      })
    );
    expect(sinks).toEqual([]);
  });

  test('nodes 行更新时以 nodes 行为准（hub 侧 node.status 后到）', () => {
    const stale = { nodeId: 'bb', name: 'B', inventoryJson: '{"notifySink":true}', lastSeenAt: 1 };
    const off = collectMeshNotificationSinks(
      input({
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        peers: [stale],
        nodes: [{ id: 'bb', name: 'B', inventoryJson: '{}', lastSeenAt: 9_000 }],
      })
    );
    expect(off).toEqual([]);

    const on = collectMeshNotificationSinks(
      input({
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        peers: [{ nodeId: 'bb', name: 'B', inventoryJson: '{}', lastSeenAt: 1 }],
        nodes: [{ id: 'bb', name: 'B', inventoryJson: '{"notifySink":true}', lastSeenAt: 9_000 }],
      })
    );
    expect(on.map((s) => s.nodeId)).toEqual(['bb']);
  });

  test('peer 行缺失时才退回 node.list，再退回 nodes 行', () => {
    const fromList = collectMeshNotificationSinks(
      input({
        listed: [{ id: 'bb', name: 'B', inventory: { notifySink: true } }],
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        nodes: [{ id: 'bb', name: 'B', inventoryJson: '{}', lastSeenAt: 9_000 }],
      })
    );
    expect(fromList.map((s) => s.nodeId)).toEqual(['bb']);
  });
});
