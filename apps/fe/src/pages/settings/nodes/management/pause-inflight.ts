// 行菜单与批量暂停 / 恢复共用的 in-flight 集：乐观翻转后对端动作不能再入队。

import { useSyncExternalStore } from 'react';

const inflight = new Set<string>();
const listeners = new Set<() => void>();
let generation = 0;

function emit(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getGeneration(): number {
  return generation;
}

export function isPauseInflight(nodeId: string): boolean {
  return inflight.has(nodeId);
}

/** 占用 in-flight；已占用则返回 false，调用方应拒绝这次动作。 */
export function beginPauseInflight(nodeId: string): boolean {
  if (inflight.has(nodeId)) return false;
  inflight.add(nodeId);
  emit();
  return true;
}

export function endPauseInflight(nodeId: string): void {
  if (!inflight.delete(nodeId)) return;
  emit();
}

export function resetPauseInflightForTest(): void {
  if (inflight.size === 0) return;
  inflight.clear();
  emit();
}

/** 订阅 in-flight 世代，批量菜单据此重算资格。 */
export function usePauseInflightGeneration(): number {
  return useSyncExternalStore(subscribe, getGeneration, getGeneration);
}

export function useIsPauseInflight(nodeId: string): boolean {
  usePauseInflightGeneration();
  return inflight.has(nodeId);
}
