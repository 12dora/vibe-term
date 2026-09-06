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
});
