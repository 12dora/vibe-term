// mesh 成员列表的首帧兜底缓存：落盘字段裁剪、读取校验、过期与条数上限。

import { describe, expect, test } from 'bun:test';
import type { MeshNode } from '@tmex/api-client/auth/index';
import {
  MESH_NODES_CACHE_MAX_AGE_MS,
  MESH_NODES_CACHE_MAX_ROWS,
  type MeshNodesCacheStorage,
  clearMeshNodesCache,
  readMeshNodesCache,
  writeMeshNodesCache,
} from './mesh-nodes-cache';

const KEY = 'tmex:mesh-nodes';
const NOW = 1_700_000_000_000;

function memoryStorage(initial: Record<string, string> = {}): MeshNodesCacheStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function node(overrides: Partial<MeshNode> & { id: string }): MeshNode {
  return {
    name: overrides.id,
    publicKey: 'AAAA',
    online: true,
    reach: 'lan',
    version: null,
    direct_capable: false,
    inventory: null,
    loggedIn: false,
    ...overrides,
  };
}

describe('mesh-nodes-cache', () => {
  test('写入后读得回来，链路现场一律清空', () => {
    const storage = memoryStorage();
    writeMeshNodesCache(
      {
        mesh: true,
        entryNodeId: 'entry',
        nodes: [
          node({
            id: 'n1',
            name: '书房',
            reach: 'wan',
            transport: 'dc',
            rttMs: 12,
            peerAddress: '10.0.0.2',
            linkSinceAt: NOW - 1000,
            directFailure: { at: NOW, ws: 'timeout' },
            loggedIn: true,
            isHub: true,
          }),
        ],
        savedAt: NOW,
      },
      storage
    );

    const cached = readMeshNodesCache(storage, NOW + 1000);
    expect(cached?.mesh).toBe(true);
    expect(cached?.entryNodeId).toBe('entry');
    expect(cached?.nodes).toHaveLength(1);
    const row = cached?.nodes[0];
    expect(row?.name).toBe('书房');
    expect(row?.online).toBe(true);
    expect(row?.loggedIn).toBe(true);
    expect(row?.isHub).toBe(true);
    // 上一次会话里那条链路的现场不可能还成立，落盘时就被裁掉
    expect(row?.reach).toBeNull();
    expect(row?.transport).toBeUndefined();
    expect(row?.rttMs).toBeUndefined();
    expect(row?.peerAddress).toBeUndefined();
    expect(row?.linkSinceAt).toBeUndefined();
    expect(row?.directFailure).toBeUndefined();
  });

  test('过期、未来时刻、版本不符、畸形 JSON 一律返回 null', () => {
    const storage = memoryStorage();
    writeMeshNodesCache(
      { mesh: true, entryNodeId: null, nodes: [node({ id: 'n1' })], savedAt: NOW },
      storage
    );
    expect(readMeshNodesCache(storage, NOW + MESH_NODES_CACHE_MAX_AGE_MS)).toBeNull();
    expect(readMeshNodesCache(storage, NOW - 1)).toBeNull();

    storage.entries.set(KEY, JSON.stringify({ v: 99, savedAt: NOW, nodes: [] }));
    expect(readMeshNodesCache(storage, NOW)).toBeNull();

    storage.entries.set(KEY, '{oops');
    expect(readMeshNodesCache(storage, NOW)).toBeNull();
  });

  test('缺字段的行被丢掉，不会把半截数据当成节点渲染', () => {
    const storage = memoryStorage();
    storage.entries.set(
      KEY,
      JSON.stringify({
        v: 1,
        mesh: true,
        entryNodeId: null,
        savedAt: NOW,
        nodes: [{ id: 'n1' }, node({ id: 'n2' })],
      })
    );
    expect(readMeshNodesCache(storage, NOW)?.nodes.map((row) => row.id)).toEqual(['n2']);
  });

  test('超过条数上限不落盘；clear 删掉整条', () => {
    const storage = memoryStorage();
    const many = Array.from({ length: MESH_NODES_CACHE_MAX_ROWS + 1 }, (_, index) =>
      node({ id: `n${index}` })
    );
    writeMeshNodesCache({ mesh: true, entryNodeId: null, nodes: many, savedAt: NOW }, storage);
    expect(storage.entries.has(KEY)).toBe(false);

    writeMeshNodesCache({ mesh: true, entryNodeId: null, nodes: [], savedAt: NOW }, storage);
    expect(storage.entries.has(KEY)).toBe(true);
    clearMeshNodesCache(storage);
    expect(storage.entries.has(KEY)).toBe(false);
  });

  test('存储不可用（隐私模式 / SSR）时读写都不抛', () => {
    const broken: MeshNodesCacheStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readMeshNodesCache(broken, NOW)).toBeNull();
    expect(() =>
      writeMeshNodesCache({ mesh: true, entryNodeId: null, nodes: [], savedAt: NOW }, broken)
    ).not.toThrow();
    expect(() => clearMeshNodesCache(broken)).not.toThrow();
    expect(readMeshNodesCache(null, NOW)).toBeNull();
  });
});
