// 「成员列表到齐了没有」的判据矩阵：standalone / 首拉未落地 / 待同步成员 / 旧网关的中继交叉验证。

import { describe, expect, test } from 'bun:test';
import {
  type InventoryReadinessInput,
  inventoryReadinessOf,
  nodesViaRelayOf,
} from './inventory-readiness';

function input(overrides: Partial<InventoryReadinessInput> = {}): InventoryReadinessInput {
  return {
    meshEnabled: true,
    loadedAt: 1,
    error: null,
    pendingMembers: 0,
    nodeCount: 1,
    nodesViaRelay: null,
    ...overrides,
  };
}

describe('inventoryReadinessOf', () => {
  test('standalone 永远就绪', () => {
    expect(inventoryReadinessOf(input({ meshEnabled: false, loadedAt: null }))).toEqual({
      ready: true,
      loading: false,
      error: null,
    });
  });

  test('首拉还没落地：加载中', () => {
    expect(inventoryReadinessOf(input({ loadedAt: null }))).toEqual({
      ready: false,
      loading: true,
      error: null,
    });
  });

  test('首拉失败不算加载中（否则会永远转下去）', () => {
    expect(inventoryReadinessOf(input({ loadedAt: null, error: 'boom' }))).toEqual({
      ready: false,
      loading: false,
      error: 'boom',
    });
  });

  test('列表到了但还有成员没解开状态块：加载中', () => {
    expect(inventoryReadinessOf(input({ pendingMembers: 2 }))).toEqual({
      ready: false,
      loading: true,
      error: null,
    });
  });

  test('真·单节点中继：就绪，空态是合法结论', () => {
    expect(inventoryReadinessOf(input({ pendingMembers: 0, nodeCount: 1 }))).toEqual({
      ready: true,
      loading: false,
      error: null,
    });
  });

  test('旧网关不下发进度：中继说的对端比列表多就算没到齐', () => {
    expect(
      inventoryReadinessOf(input({ pendingMembers: null, nodeCount: 1, nodesViaRelay: 2 }))
    ).toEqual({ ready: false, loading: true, error: null });
  });

  test('旧网关：列表已经追上中继就算就绪', () => {
    expect(
      inventoryReadinessOf(input({ pendingMembers: null, nodeCount: 3, nodesViaRelay: 2 }))
    ).toEqual({ ready: true, loading: false, error: null });
  });

  test('新网关的 pendingMembers 优先于中继交叉验证', () => {
    expect(
      inventoryReadinessOf(input({ pendingMembers: 0, nodeCount: 1, nodesViaRelay: 5 }))
    ).toEqual({ ready: true, loading: false, error: null });
  });

  test('陈旧磁盘缓存（loadedAt 仍为 null）按加载中处理，界面照旧画缓存里的成员', () => {
    expect(inventoryReadinessOf(input({ loadedAt: null, nodeCount: 3 }))).toEqual({
      ready: false,
      loading: true,
      error: null,
    });
  });
});

describe('nodesViaRelayOf', () => {
  test('中继链路还没读到时不参与判定', () => {
    expect(nodesViaRelayOf({ mode: 'relay', loadedAt: null, nodesViaRelay: 3 })).toBeNull();
  });

  test('非中继模式不参与判定', () => {
    expect(nodesViaRelayOf({ mode: 'hub', loadedAt: 1, nodesViaRelay: 3 })).toBeNull();
  });

  test('中继模式且已读到：用它的成员数', () => {
    expect(nodesViaRelayOf({ mode: 'relay', loadedAt: 1, nodesViaRelay: 3 })).toBe(3);
  });
});
