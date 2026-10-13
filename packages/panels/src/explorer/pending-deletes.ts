// 进行中的删除：确认后条目先从视图里隐藏，请求落定（成功或失败）即撤销隐藏。
// 状态放在模块级、按「节点 + 根 + 目录」分桶，不跟组件或当前位置绑定——
// 用户中途去了别的目录、换了标签页甚至关掉再开，落定时都能对上账，不会留下永远看不见的条目。

import { useCallback, useSyncExternalStore } from 'react';

const EMPTY: ReadonlySet<string> = new Set<string>();

/** 每个桶里是若干次尚未落定的删除各自的路径 */
const operations = new Map<string, Set<readonly string[]>>();
const snapshots = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

export function pendingDeleteScope(nodeId: string, rootId: string, dir: string): string {
  return `${nodeId}\n${rootId}\n${dir}`;
}

function refresh(scope: string): void {
  const pending = operations.get(scope);
  if (!pending || pending.size === 0) {
    operations.delete(scope);
    snapshots.delete(scope);
  } else {
    snapshots.set(scope, new Set([...pending].flat()));
  }
  for (const listener of [...listeners]) listener();
}

/** 登记一次删除；返回的函数在请求落定时调用（可重复调用，只生效一次）。 */
export function beginPendingDelete(scope: string, paths: readonly string[]): () => void {
  if (paths.length === 0) return () => {};
  const operation = [...paths];
  const pending = operations.get(scope) ?? new Set<readonly string[]>();
  pending.add(operation);
  operations.set(scope, pending);
  refresh(scope);
  return () => {
    if (operations.get(scope)?.delete(operation)) refresh(scope);
  };
}

/** 该目录下正在删除的路径；没有时返回同一个空集合（引用稳定）。 */
export function pendingDeletePaths(scope: string): ReadonlySet<string> {
  return snapshots.get(scope) ?? EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingDeletes(scope: string): ReadonlySet<string> {
  const read = useCallback(() => pendingDeletePaths(scope), [scope]);
  return useSyncExternalStore(subscribe, read, read);
}
