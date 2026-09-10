// tmux 窗口 / pane 拓扑的本地缓存：PWA 冷启动时先把上一次会话的「标签页」列出来，
// 用户点某一格终端才真正 attach。
//
// 只存结构（窗口与 pane 的 id / 序号 / 名字 / 活动位），不存屏幕内容、尺寸、布局串，
// 也不存任何带凭据语义的字段——这份数据落在 localStorage，等同于公开。
//
// 键按 runtime 的 storagePrefix 分（与 `device-intent-store` 同一套分区口径），
// 一个前缀一份设备表：条目数、窗口数、pane 数三层封顶，超期（TTL）与超量（LRU）都在读写时清掉。

import type { TmuxSession } from '@vibeterm/shared';

export const TMUX_TOPOLOGY_CACHE_VERSION = 1;
export const TMUX_TOPOLOGY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 一个前缀下最多缓存多少台设备（按 savedAt LRU 淘汰） */
export const MAX_CACHED_DEVICES = 32;
export const MAX_CACHED_WINDOWS = 32;
export const MAX_CACHED_PANES = 16;
/** 每台设备的写入节流窗口：终端刷屏期间快照会连续变，落盘至多 1 次/秒 */
export const TOPOLOGY_WRITE_INTERVAL_MS = 1000;

const KEY_SUFFIX = 'vibeterm:tmux-topology';

export interface CachedTopologyPane {
  id: string;
  index: number;
  active: boolean;
  title?: string;
  customName?: string;
  currentCommand?: string;
}

export interface CachedTopologyWindow {
  id: string;
  index: number;
  name: string;
  active: boolean;
  customName?: string;
  panes: CachedTopologyPane[];
}

export interface CachedTopology {
  savedAt: number;
  windows: CachedTopologyWindow[];
}

/** deviceId → 上次会话的拓扑；只在该设备还没有实时快照时用于渲染占位 */
export type TmuxTopologyPlaceholders = Record<string, CachedTopology | undefined>;

export interface TopologyCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedCache {
  version: number;
  devices: Record<string, CachedTopology>;
}

export function tmuxTopologyCacheKey(storagePrefix: string): string {
  return `${storagePrefix}${KEY_SUFFIX}`;
}

function defaultStorage(): TopologyCacheStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------- 快照 → 缓存 ----------

function toCachedPane(pane: TmuxSession['windows'][number]['panes'][number]): CachedTopologyPane {
  const cached: CachedTopologyPane = { id: pane.id, index: pane.index, active: pane.active };
  if (pane.title) cached.title = pane.title;
  if (pane.customName) cached.customName = pane.customName;
  if (pane.currentCommand) cached.currentCommand = pane.currentCommand;
  return cached;
}

function toCachedWindow(tmuxWindow: TmuxSession['windows'][number]): CachedTopologyWindow {
  const cached: CachedTopologyWindow = {
    id: tmuxWindow.id,
    index: tmuxWindow.index,
    name: tmuxWindow.name,
    active: tmuxWindow.active,
    panes: tmuxWindow.panes.slice(0, MAX_CACHED_PANES).map(toCachedPane),
  };
  if (tmuxWindow.customName) cached.customName = tmuxWindow.customName;
  return cached;
}

/** 实时快照里的会话 → 可落盘的拓扑；没有窗口的会话不值得缓存（返回 null 即删除该条） */
export function toCachedTopology(
  session: TmuxSession | null | undefined,
  now = Date.now()
): CachedTopology | null {
  const windows = session?.windows;
  if (!windows || windows.length === 0) return null;
  return { savedAt: now, windows: windows.slice(0, MAX_CACHED_WINDOWS).map(toCachedWindow) };
}

// ---------- 反序列化 ----------

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsePane(value: unknown): CachedTopologyPane | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) return null;
  const pane: CachedTopologyPane = {
    id: row.id,
    index: typeof row.index === 'number' ? row.index : 0,
    active: row.active === true,
  };
  const title = optionalText(row.title);
  if (title) pane.title = title;
  const customName = optionalText(row.customName);
  if (customName) pane.customName = customName;
  const currentCommand = optionalText(row.currentCommand);
  if (currentCommand) pane.currentCommand = currentCommand;
  return pane;
}

function parseWindow(value: unknown): CachedTopologyWindow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) return null;
  const panes = Array.isArray(row.panes)
    ? row.panes
        .slice(0, MAX_CACHED_PANES)
        .map(parsePane)
        .filter((pane): pane is CachedTopologyPane => pane !== null)
    : [];
  const cached: CachedTopologyWindow = {
    id: row.id,
    index: typeof row.index === 'number' ? row.index : 0,
    name: typeof row.name === 'string' ? row.name : '',
    active: row.active === true,
    panes,
  };
  const customName = optionalText(row.customName);
  if (customName) cached.customName = customName;
  return cached;
}

function parseTopology(value: unknown, now: number): CachedTopology | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.savedAt !== 'number' || !Number.isFinite(row.savedAt)) return null;
  if (now - row.savedAt > TMUX_TOPOLOGY_TTL_MS) return null;
  if (!Array.isArray(row.windows)) return null;
  const windows = row.windows
    .slice(0, MAX_CACHED_WINDOWS)
    .map(parseWindow)
    .filter((tmuxWindow): tmuxWindow is CachedTopologyWindow => tmuxWindow !== null);
  if (windows.length === 0) return null;
  return { savedAt: row.savedAt, windows };
}

/** 版本不符 / 结构不对 / 已过期的条目一律丢弃；解析失败返回空表而不是抛错 */
function parseCache(raw: string | null, now: number): Record<string, CachedTopology> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const cache = parsed as Partial<PersistedCache>;
    if (cache.version !== TMUX_TOPOLOGY_CACHE_VERSION) return {};
    if (!cache.devices || typeof cache.devices !== 'object') return {};
    const devices: Record<string, CachedTopology> = {};
    for (const [deviceId, value] of Object.entries(cache.devices as Record<string, unknown>)) {
      const topology = parseTopology(value, now);
      if (deviceId && topology) devices[deviceId] = topology;
    }
    return devices;
  } catch {
    return {};
  }
}

/** 超出条目上限时淘汰 savedAt 最小的几条（keepDeviceId 永不淘汰） */
function evictOverflow(
  devices: Record<string, CachedTopology>,
  keepDeviceId: string | null
): Record<string, CachedTopology> {
  const ids = Object.keys(devices);
  if (ids.length <= MAX_CACHED_DEVICES) return devices;
  const ordered = ids
    .filter((id) => id !== keepDeviceId)
    .sort((a, b) => (devices[b]?.savedAt ?? 0) - (devices[a]?.savedAt ?? 0));
  const kept = new Set(
    ordered.slice(0, keepDeviceId ? MAX_CACHED_DEVICES - 1 : MAX_CACHED_DEVICES)
  );
  if (keepDeviceId) kept.add(keepDeviceId);
  const next: Record<string, CachedTopology> = {};
  for (const id of ids) if (kept.has(id)) next[id] = devices[id] as CachedTopology;
  return next;
}

function readRaw(storage: TopologyCacheStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeCache(
  storage: TopologyCacheStorage,
  key: string,
  devices: Record<string, CachedTopology>
): void {
  try {
    if (Object.keys(devices).length === 0) {
      storage.removeItem(key);
      return;
    }
    const payload: PersistedCache = { version: TMUX_TOPOLOGY_CACHE_VERSION, devices };
    storage.setItem(key, JSON.stringify(payload));
  } catch {
    // 配额 / 隐私模式：缓存只是首屏占位，写不进去就当没有
  }
}

// ---------- 对外读写 ----------

export function readTmuxTopologyCache(
  storagePrefix: string,
  storage: TopologyCacheStorage | null = defaultStorage(),
  now = Date.now()
): TmuxTopologyPlaceholders {
  if (!storage) return {};
  return parseCache(readRaw(storage, tmuxTopologyCacheKey(storagePrefix)), now);
}

export function writeTmuxTopology(
  storagePrefix: string,
  deviceId: string,
  topology: CachedTopology,
  storage: TopologyCacheStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage || !deviceId) return;
  const key = tmuxTopologyCacheKey(storagePrefix);
  const devices = parseCache(readRaw(storage, key), now);
  devices[deviceId] = topology;
  writeCache(storage, key, evictOverflow(devices, deviceId));
}

export function removeTmuxTopology(
  storagePrefix: string,
  deviceId: string,
  storage: TopologyCacheStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage || !deviceId) return;
  const key = tmuxTopologyCacheKey(storagePrefix);
  const devices = parseCache(readRaw(storage, key), now);
  if (!(deviceId in devices)) return;
  delete devices[deviceId];
  writeCache(storage, key, devices);
}

/**
 * 只保留仍在设备列表里的条目：设备被删掉时它的窗口名没有留存价值。
 * 未连接过的设备走不到「退出 connectedDevices」那条清理路径，靠这里兜底。
 */
export function pruneTmuxTopologyCache(
  storagePrefix: string,
  keepDeviceIds: Iterable<string>,
  storage: TopologyCacheStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage) return;
  const keep = new Set(keepDeviceIds);
  const key = tmuxTopologyCacheKey(storagePrefix);
  const devices = parseCache(readRaw(storage, key), now);
  const stale = Object.keys(devices).filter((deviceId) => !keep.has(deviceId));
  if (stale.length === 0) return;
  for (const deviceId of stale) delete devices[deviceId];
  writeCache(storage, key, devices);
}

/** 登出 / 换账号：整份丢掉，别把上一位用户的窗口名留给下一位 */
export function clearTmuxTopologyCache(
  storagePrefix: string,
  storage: TopologyCacheStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.removeItem(tmuxTopologyCacheKey(storagePrefix));
  } catch {
    // 存储不可用时无事可做
  }
}

// ---------- 与 tmux store 的写通 / 占位对账 ----------

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

/** 每设备至多 1 次/秒的落盘节流器：窗口内的后续变更只更新待写内容，不额外排定时器 */
function createTopologyWriter(options: TopologySyncOptions) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const lastWriteAt = new Map<string, number>();
  const pending = new Map<string, PendingWrite>();

  const flush = (deviceId: string, session: TmuxSession | null): void => {
    lastWriteAt.set(deviceId, now());
    const topology = toCachedTopology(session, now());
    if (topology) writeTmuxTopology(options.storagePrefix, deviceId, topology, storage, now());
    else removeTmuxTopology(options.storagePrefix, deviceId, storage, now());
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
      removeTmuxTopology(options.storagePrefix, deviceId, storage, now());
    },

    dispose(): void {
      for (const [deviceId, entry] of pending) {
        timers.clearTimer(entry.handle);
        flush(deviceId, entry.session);
      }
      pending.clear();
      lastWriteAt.clear();
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
 * - `snapshots[deviceId]` 换引用即排一次落盘（节流后）；
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
