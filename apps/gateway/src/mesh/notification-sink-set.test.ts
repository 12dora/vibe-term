import { afterEach, describe, expect, test } from 'bun:test';
import { resetNodePauseForTests, setNodePaused } from './node-pause';
import { type SinkSetInput, collectMeshNotificationSinks } from './notification-sink-set';

function input(overrides: Partial<SinkSetInput> = {}): SinkSetInput {
  return {
    selfNodeId: 'aa',
    selfName: '本机',
    selfEnabled: false,
    declared: new Set(),
    listed: [],
    certs: [],
    peers: [],
    nodes: [],
    reach: new Map(),
    hubOnline: new Set(),
    ...overrides,
  };
}

afterEach(() => {
  resetNodePauseForTests();
});

describe('collectMeshNotificationSinks', () => {
  test('本机有签名声明且开关打开时进集合并标 self/online', () => {
    const sinks = collectMeshNotificationSinks(
      input({ selfEnabled: true, declared: new Set(['aa']) })
    );
    expect(sinks).toEqual([{ nodeId: 'aa', name: '本机', self: true, online: true }]);
  });

  test('本机开关关着就不在集合里（声明还在也一样）', () => {
    expect(collectMeshNotificationSinks(input({ declared: new Set(['aa']) }))).toEqual([]);
  });

  test('本机开关打开但没有签名声明也不算汇聚机', () => {
    expect(collectMeshNotificationSinks(input({ selfEnabled: true }))).toEqual([]);
  });

  test('远端节点只按签名声明判定，节点自述的 inventory 不参与', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        declared: new Set(['bb']),
        listed: [{ id: 'bb', name: 'B' }],
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        hubOnline: new Set(['bb']),
      })
    );
    expect(sinks).toEqual([{ nodeId: 'bb', name: 'B', self: false, online: true }]);
  });

  test('没有签名声明的节点一律不算汇聚机', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        certs: [
          { nodeId: 'bb', revokedLogSeq: null },
          { nodeId: 'cc', revokedLogSeq: null },
        ],
        peers: [
          { nodeId: 'bb', name: 'B' },
          { nodeId: 'cc', name: 'C' },
        ],
      })
    );
    expect(sinks).toEqual([]);
  });

  test('显示名取 node.list → 注册表 → peer 行；离线也保留在集合里', () => {
    const fromPeer = collectMeshNotificationSinks(
      input({
        declared: new Set(['bb']),
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        peers: [{ nodeId: 'bb', name: 'B-peer' }],
        reach: new Map([['bb', 'lan']]),
      })
    );
    expect(fromPeer).toEqual([{ nodeId: 'bb', name: 'B-peer', self: false, online: true }]);

    const fromNodes = collectMeshNotificationSinks(
      input({
        declared: new Set(['bb']),
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        nodes: [{ id: 'bb', name: 'B-node' }],
      })
    );
    expect(fromNodes).toEqual([{ nodeId: 'bb', name: 'B-node', self: false, online: false }]);
  });

  test('已吊销的证书不进集合', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        declared: new Set(['bb']),
        certs: [{ nodeId: 'bb', revokedLogSeq: 12 }],
        peers: [{ nodeId: 'bb', name: 'B' }],
      })
    );
    expect(sinks).toEqual([]);
  });

  test('本机排在最前，其余按名字排序', () => {
    const sinks = collectMeshNotificationSinks(
      input({
        selfEnabled: true,
        declared: new Set(['aa', 'bb', 'cc']),
        certs: [
          { nodeId: 'bb', revokedLogSeq: null },
          { nodeId: 'cc', revokedLogSeq: null },
        ],
        peers: [
          { nodeId: 'cc', name: 'Alpha' },
          { nodeId: 'bb', name: 'Zulu' },
        ],
      })
    );
    expect(sinks.map((s) => s.name)).toEqual(['本机', 'Alpha', 'Zulu']);
  });

  test('skips paused remote sinks but keeps self', () => {
    setNodePaused('bb', true);
    const sinks = collectMeshNotificationSinks(
      input({
        selfEnabled: true,
        declared: new Set(['aa', 'bb']),
        certs: [{ nodeId: 'bb', revokedLogSeq: null }],
        listed: [{ id: 'bb', name: 'B' }],
        hubOnline: new Set(['bb']),
      })
    );
    expect(sinks.map((s) => s.nodeId)).toEqual(['aa']);
  });
});
