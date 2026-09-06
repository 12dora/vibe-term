// 「没能删掉的放行记录」清单。删除映射或回滚创建时，如果目标节点 B 上的放行记录没删成功
// （B 离线、会话过期、请求失败），A 侧的映射已经不在了，B 上却仍留着一条对 A 放行的记录：
// 拿着同一个 mapId 的 A 仍能连上 B 的那个服务。所以这类残留必须留痕并可重试，
// 且要跨刷新存活——落在 localStorage 里，隐私模式 / 配额异常时退化成「只在本次会话里有效」。

import { useCallback, useSyncExternalStore } from 'react';

export const PENDING_CLEANUP_KEY = 'tmex:portmap-pending-cleanup';
/** 上限：残留是异常路径，攒到这个数说明目标节点长期不可用，只保留最近的。 */
export const MAX_PENDING_CLEANUPS = 20;

export interface PendingExportCleanup {
  /** 与 A 侧映射同 id。 */
  mapId: string;
  /** 监听方 A 的真实 mesh id；`confirmed` 为 false 时用它复核 A 上到底有没有这条映射。 */
  listenMeshId: string;
  /** 目标方 B 的真实 mesh id：放行记录在它上面。 */
  targetMeshId: string;
  /** 列表里的展示名（映射名或监听端口）。 */
  label: string;
  /** A 上确实已无此映射（删除成功或创建被明确拒绝）；false 表示还没复核过。 */
  confirmed: boolean;
  createdAt: number;
}

export interface PendingCleanupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storageOverride: PendingCleanupStorage | null = null;

function activeStorage(): PendingCleanupStorage | null {
  if (storageOverride) return storageOverride;
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 解析落盘内容；任何一条不合规就丢掉，不让坏数据卡住整张清单。 */
export function parsePendingCleanups(raw: string | null): PendingExportCleanup[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const list: PendingExportCleanup[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const { mapId, listenMeshId, targetMeshId, label, confirmed, createdAt } = item;
    if (typeof mapId !== 'string' || mapId === '') continue;
    if (typeof listenMeshId !== 'string' || typeof targetMeshId !== 'string') continue;
    list.push({
      mapId,
      listenMeshId,
      targetMeshId,
      label: typeof label === 'string' ? label : mapId,
      confirmed: confirmed === true,
      createdAt: typeof createdAt === 'number' ? createdAt : 0,
    });
  }
  return list.slice(-MAX_PENDING_CLEANUPS);
}

let cache: readonly PendingExportCleanup[] | null = null;
const listeners = new Set<() => void>();

function persist(list: readonly PendingExportCleanup[]): void {
  const storage = activeStorage();
  if (!storage) return;
  try {
    if (list.length === 0) storage.removeItem(PENDING_CLEANUP_KEY);
    else storage.setItem(PENDING_CLEANUP_KEY, JSON.stringify(list));
  } catch {
    // 写不进去只影响刷新后能否接着重试，本次会话内的清单仍在
  }
}

function commit(list: readonly PendingExportCleanup[]): void {
  cache = list;
  persist(list);
  for (const listener of listeners) listener();
}

export function pendingExportCleanups(): readonly PendingExportCleanup[] {
  if (cache) return cache;
  const storage = activeStorage();
  cache = storage ? parsePendingCleanups(storage.getItem(PENDING_CLEANUP_KEY)) : [];
  return cache;
}

/** 登记一条待清理；同一 mapId 只留最新的一条。 */
export function recordPendingExportCleanup(record: PendingExportCleanup): void {
  const kept = pendingExportCleanups().filter((item) => item.mapId !== record.mapId);
  commit([...kept, record].slice(-MAX_PENDING_CLEANUPS));
}

/** 清理成功（或确认映射仍在，本就无需清理）后摘掉。 */
export function resolvePendingExportCleanup(mapId: string): void {
  const kept = pendingExportCleanups().filter((item) => item.mapId !== mapId);
  if (kept.length === pendingExportCleanups().length) return;
  commit(kept);
}

export function subscribePendingExportCleanups(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePendingExportCleanups(): readonly PendingExportCleanup[] {
  return useSyncExternalStore(
    useCallback((listener: () => void) => subscribePendingExportCleanups(listener), []),
    pendingExportCleanups,
    pendingExportCleanups
  );
}

/** 单测注入内存 storage（无 DOM 环境下 `window` 不存在，持久化路径需要显式替身）。 */
export function setPendingCleanupStorageForTest(next: PendingCleanupStorage | null): void {
  storageOverride = next;
  cache = null;
}

export function resetPendingExportCleanupsForTest(): void {
  cache = [];
  persist([]);
  for (const listener of listeners) listener();
}
