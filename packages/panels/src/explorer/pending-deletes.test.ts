import { describe, expect, test } from 'bun:test';
import { beginPendingDelete, pendingDeletePaths, pendingDeleteScope } from './pending-deletes';

const scopeA = pendingDeleteScope('self', 'r1', '/root/a');
const scopeB = pendingDeleteScope('self', 'r1', '/root/b');

describe('pending deletes', () => {
  test('登记后可见，落定后撤销，且不依赖当前所在目录', () => {
    const settle = beginPendingDelete(scopeA, ['/root/a/x', '/root/a/y']);
    expect([...pendingDeletePaths(scopeA)].sort()).toEqual(['/root/a/x', '/root/a/y']);
    expect(pendingDeletePaths(scopeB).size).toBe(0);
    settle();
    expect(pendingDeletePaths(scopeA).size).toBe(0);
  });

  test('没有进行中的删除时返回同一个空集合', () => {
    expect(pendingDeletePaths(scopeA)).toBe(pendingDeletePaths(scopeB));
  });

  test('没有变化时快照引用稳定', () => {
    const settle = beginPendingDelete(scopeA, ['/root/a/x']);
    expect(pendingDeletePaths(scopeA)).toBe(pendingDeletePaths(scopeA));
    settle();
  });

  test('同一目录的两次删除各自落定，互不影响', () => {
    const first = beginPendingDelete(scopeA, ['/root/a/x']);
    const second = beginPendingDelete(scopeA, ['/root/a/y']);
    first();
    expect([...pendingDeletePaths(scopeA)]).toEqual(['/root/a/y']);
    second();
    expect(pendingDeletePaths(scopeA).size).toBe(0);
  });

  test('重复落定只生效一次，不会误撤别的操作', () => {
    const first = beginPendingDelete(scopeA, ['/root/a/x']);
    first();
    const second = beginPendingDelete(scopeA, ['/root/a/x']);
    first();
    expect([...pendingDeletePaths(scopeA)]).toEqual(['/root/a/x']);
    second();
    expect(pendingDeletePaths(scopeA).size).toBe(0);
  });

  test('不同节点、不同根的同名目录互相隔离', () => {
    const settle = beginPendingDelete(scopeA, ['/root/a/x']);
    expect(pendingDeletePaths(pendingDeleteScope('n2', 'r1', '/root/a')).size).toBe(0);
    expect(pendingDeletePaths(pendingDeleteScope('self', 'r2', '/root/a')).size).toBe(0);
    settle();
  });

  test('空路径列表不登记', () => {
    const settle = beginPendingDelete(scopeA, []);
    expect(pendingDeletePaths(scopeA).size).toBe(0);
    settle();
  });
});
