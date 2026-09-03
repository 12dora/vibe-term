// UI store 的持久化存储适配器：把「只改了草稿」的写入攒起来，其余字段照旧同步落盘。
//
// zustand persist 每次 set 都会走一遍 partialize → JSON.stringify → localStorage.setItem，
// 而 editor 模式每敲一个键就是一次 set：整份 17 键快照（含 50 条历史与全部草稿）被重新序列化
// 并同步写盘，全发生在输入的关键路径上。这里接管 PersistStorage（不走 createJSONStorage），
// 于是拿到的是 partialize 后的**对象**，可以在序列化之前先判断这次变化值不值得落盘：
//
//   - 与上次落盘逐字段同引用 → 跳过（同 agent.ts 的 dedupedStorage）；
//   - 只有 deferredKeys 变了 → 记为待写，最多 debounceMs 后合并成一次写；
//   - 其它字段变了 → 立即写（顺带把待写的草稿一起落盘）。
//
// 定时器只在首次挂起时武装、后续不重置，所以连续输入也保证每 debounceMs 至少落一次盘；
// 页面进入后台 / 卸载时由调用方 flush（见 ui.ts）。

import type { PersistStorage, StorageValue } from 'zustand/middleware';

export const UI_DRAFT_PERSIST_DEBOUNCE_MS = 300;

export interface DeferredPersistTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

type WritableStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface DeferredPersistOptions<T extends object> {
  /** 只有这些字段变化时才允许延后落盘 */
  deferredKeys: readonly (keyof T)[];
  debounceMs?: number;
  timers?: DeferredPersistTimers;
  storage?: WritableStorage;
}

export interface DeferredPersistStorage<T extends object> {
  storage: PersistStorage<T>;
  /** 立即落盘尚未写出的草稿；无待写时无副作用 */
  flush: () => void;
  /** 取消未触发的定时器并丢弃 pending，避免销毁后的迟到写覆盖新 runtime */
  dispose: () => void;
}

const defaultTimers: DeferredPersistTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 沙箱 iframe / 隐私模式下访问 localStorage 会抛，一律降级为无操作 */
function browserStorage(): WritableStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

type ChangeKind = 'none' | 'deferred' | 'immediate';

function changeKind<T extends object>(
  previous: T | null,
  next: T,
  deferred: ReadonlySet<keyof T>
): ChangeKind {
  if (previous === null) return 'immediate';
  const keys = Object.keys(next) as (keyof T)[];
  if (Object.keys(previous).length !== keys.length) return 'immediate';

  let changed = false;
  for (const key of keys) {
    if (Object.is(previous[key], next[key])) continue;
    if (!deferred.has(key)) return 'immediate';
    changed = true;
  }
  return changed ? 'deferred' : 'none';
}

export function createDeferredPersistStorage<T extends object>(
  options: DeferredPersistOptions<T>
): DeferredPersistStorage<T> {
  const debounceMs = options.debounceMs ?? UI_DRAFT_PERSIST_DEBOUNCE_MS;
  const timers = options.timers ?? defaultTimers;
  const deferred = new Set(options.deferredKeys);

  let written: T | null = null;
  let pending: { name: string; value: StorageValue<T> } | null = null;
  let handle: unknown = null;
  let disposed = false;

  const resolveStorage = (): WritableStorage | null => options.storage ?? browserStorage();

  const cancelTimer = () => {
    if (handle === null) return;
    timers.clear(handle);
    handle = null;
  };

  const write = (name: string, value: StorageValue<T>) => {
    cancelTimer();
    pending = null;
    written = value.state;
    const storage = resolveStorage();
    if (!storage) return;
    try {
      storage.setItem(name, JSON.stringify(value));
    } catch {
      return;
    }
  };

  const flush = () => {
    if (disposed || !pending) return;
    write(pending.name, pending.value);
  };

  const dispose = () => {
    cancelTimer();
    pending = null;
    disposed = true;
  };

  return {
    flush,
    dispose,
    storage: {
      getItem: (name) => {
        const storage = resolveStorage();
        if (!storage) return null;
        let raw: string | null;
        try {
          raw = storage.getItem(name);
        } catch {
          return null;
        }
        if (raw === null) return null;
        try {
          return JSON.parse(raw) as StorageValue<T>;
        } catch {
          return null;
        }
      },
      setItem: (name, value) => {
        if (disposed) return;
        const next = value.state;
        if (changeKind(written, next, deferred) === 'none') {
          cancelTimer();
          pending = null;
          return;
        }
        switch (changeKind(pending?.value.state ?? written, next, deferred)) {
          case 'none':
            return;
          case 'deferred':
            pending = { name, value };
            if (handle === null) {
              handle = timers.set(() => {
                handle = null;
                flush();
              }, debounceMs);
            }
            return;
          default:
            write(name, value);
        }
      },
      removeItem: (name) => {
        cancelTimer();
        pending = null;
        written = null;
        const storage = resolveStorage();
        if (!storage) return;
        try {
          storage.removeItem(name);
        } catch {
          return;
        }
      },
    },
  };
}
