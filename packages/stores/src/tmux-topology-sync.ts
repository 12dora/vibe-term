// tmux store → 拓扑缓存的写通与占位对账。缓存本体（序列化、容量、句柄）在
// `tmux-topology-cache.ts`，这里只负责「什么时候写、什么时候删占位」。

import type { TmuxSession } from '@vibeterm/shared';
import {
  TOPOLOGY_WRITE_INTERVAL_MS,
  type TmuxTopologyPlaceholders,
  type TopologyCacheStorage,
  toCachedWindows,
  topologyCacheHandle,
} from './tmux-topology-cache';

export interface TopologySyncState {
  snapshots: Record<string, { session: TmuxSession | null } | undefined>;
  connectedDevices: ReadonlySet<string>;
  topologyPlaceholders: TmuxTopologyPlaceholders;
}

export interface TopologySyncStore {
  getState(): TopologySyncState;
  setState(partial: { topologyPlaceholders: TmuxTopologyPlaceholders }): void;
  subscribe(listener: () => void): () => void;
}

export interface TopologySyncTimers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface TopologySyncOptions {
  storagePrefix: string;
  storage?: TopologyCacheStorage | null;
  now?: () => number;
  timers?: TopologySyncTimers;
}

const defaultTimers: TopologySyncTimers = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingWrite {
  session: TmuxSession | null;
  handle: unknown;
}

/**
 * 每设备至多 1 次/秒的落盘节流器：窗口内的后续变更只更新待写内容，不额外排定时器。
 * 是否真的写盘由句柄的指纹决定——节流窗口到点但拓扑没变时一个字节都不写。
 */
function createTopologyWriter(options: TopologySyncOptions) {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const cache = topologyCacheHandle(options.storagePrefix, options.storage);
  const lastWriteAt = new Map<string, number>();
  const pending = new Map<string, PendingWrite>();

  const flush = (deviceId: string, session: TmuxSession | null): void => {
    if (!cache) return;
    const windows = toCachedWindows(session);
    if (!windows) {
      cache.remove(deviceId, now());
      lastWriteAt.delete(deviceId);
      return;
    }
    // 没写盘就不推进节流窗口，下一次真变化可以立刻落地
    if (cache.put(deviceId, { savedAt: now(), windows })) lastWriteAt.set(deviceId, now());
  };

  return {
    save(deviceId: string, session: TmuxSession | null): void {
      const existing = pending.get(deviceId);
      if (existing) {
        existing.session = session;
        return;
      }
      const wait =
        TOPOLOGY_WRITE_INTERVAL_MS -
        (now() - (lastWriteAt.get(deviceId) ?? Number.NEGATIVE_INFINITY));
      if (wait <= 0) {
        flush(deviceId, session);
        return;
      }
      const handle = timers.setTimer(() => {
        const entry = pending.get(deviceId);
        pending.delete(deviceId);
        if (entry) flush(deviceId, entry.session);
      }, wait);
      pending.set(deviceId, { session, handle });
    },

    drop(deviceId: string): void {
      const entry = pending.get(deviceId);
      if (entry) {
        timers.clearTimer(entry.handle);
        pending.delete(deviceId);
      }
      lastWriteAt.delete(deviceId);
      cache?.remove(deviceId, now());
    },

    dispose(): void {
      for (const [deviceId, entry] of pending) {
        timers.clearTimer(entry.handle);
        flush(deviceId, entry.session);
      }
      pending.clear();
      lastWriteAt.clear();
      cache?.forgetFingerprints();
    },
  };
}

/** 占位表对账：实时快照到货即摘掉该设备的占位（占位与实时数据不得同时出现） */
function dropSettledPlaceholders(store: TopologySyncStore, dropped: readonly string[]): void {
  const state = store.getState();
  const placeholders = state.topologyPlaceholders;
  const stale = Object.keys(placeholders).filter(
    (deviceId) => placeholders[deviceId] !== undefined && state.snapshots[deviceId] !== undefined
  );
  const removals = [...new Set([...stale, ...dropped])].filter(
    (deviceId) => placeholders[deviceId] !== undefined
  );
  if (removals.length === 0) return;
  const next = { ...placeholders };
  for (const deviceId of removals) delete next[deviceId];
  store.setState({ topologyPlaceholders: next });
}

/**
 * 把 tmux store 的快照变化写通到本地缓存，并维护占位表。
 *
 * - `snapshots[deviceId]` 换引用即排一次落盘（节流 + 指纹去重后）；
 * - 设备退出 `connectedDevices`（用户主动断开 / 设备被删）即删掉它的缓存与占位；
 * - 实时快照到货即摘掉占位。
 */
export function syncTmuxTopologyCache(
  store: TopologySyncStore,
  options: TopologySyncOptions
): () => void {
  const writer = createTopologyWriter(options);
  let lastSnapshots = store.getState().snapshots;
  let lastConnected = store.getState().connectedDevices;

  const handleChange = (): void => {
    const state = store.getState();
    const { snapshots, connectedDevices } = state;

    if (snapshots !== lastSnapshots) {
      for (const [deviceId, snapshot] of Object.entries(snapshots)) {
        if (snapshot === undefined || snapshot === lastSnapshots[deviceId]) continue;
        writer.save(deviceId, snapshot.session);
      }
    }

    const dropped: string[] = [];
    if (connectedDevices !== lastConnected) {
      for (const deviceId of lastConnected) {
        if (connectedDevices.has(deviceId)) continue;
        writer.drop(deviceId);
        dropped.push(deviceId);
      }
    }

    lastSnapshots = snapshots;
    lastConnected = connectedDevices;
    dropSettledPlaceholders(store, dropped);
  };

  const unsubscribe = store.subscribe(handleChange);
  return () => {
    unsubscribe();
    writer.dispose();
  };
}
