// tmux 窗口 / pane 拓扑的本地缓存：PWA 冷启动时先把上一次会话的「标签页」列出来，
// 用户点某一格终端才真正 attach。
//
// 只存结构（窗口与 pane 的 id / 序号 / 名字 / 活动位），不存屏幕内容、尺寸、布局串，
// 也不存任何带凭据语义的字段——这份数据落在 localStorage，等同于公开。
//
// 键按 runtime 的 storagePrefix 分（与 `device-intent-store` 同一套分区口径），
// 一个前缀一份设备表：条目数、窗口数、pane 数、单条文本长度、整份序列化长度五层封顶，
// 超期（TTL）与超量都在读写时清掉。
//
// 写入走**每前缀一份内存副本 + 每设备一份拓扑指纹**：metadata-patch 会因 pane 标题 /
// 活动位 / 进程名的抖动持续到来，若每次都 read → parse → stringify → setItem，
// 光是「savedAt 变了」就能把整张表反复写一遍。指纹不变即一个字节都不写。

import type { TmuxSession } from '@vibeterm/shared';

export const TMUX_TOPOLOGY_CACHE_VERSION = 1;
export const TMUX_TOPOLOGY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 一个前缀下最多缓存多少台设备（按 savedAt LRU 淘汰） */
export const MAX_CACHED_DEVICES = 32;
export const MAX_CACHED_WINDOWS = 32;
export const MAX_CACHED_PANES = 16;
/** 单条文本字段（窗口名 / pane 标题 / 进程名）落盘前的截断长度 */
export const MAX_CACHED_TEXT_CHARS = 120;
/** 整份缓存序列化后的长度预算（UTF-16 码元，约 128 KiB） */
export const MAX_CACHE_CHARS = 128 * 1024;
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

/** 落盘用文本：空串当没有，超长截断（tmux 标题可以是整行命令，不设上限就是无底洞） */
function cachedText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > MAX_CACHED_TEXT_CHARS ? value.slice(0, MAX_CACHED_TEXT_CHARS) : value;
}

// ---------- 快照 → 缓存 ----------

function toCachedPane(pane: TmuxSession['windows'][number]['panes'][number]): CachedTopologyPane {
  const cached: CachedTopologyPane = { id: pane.id, index: pane.index, active: pane.active };
  const title = cachedText(pane.title);
  if (title) cached.title = title;
  const customName = cachedText(pane.customName);
  if (customName) cached.customName = customName;
  const currentCommand = cachedText(pane.currentCommand);
  if (currentCommand) cached.currentCommand = currentCommand;
  return cached;
}

function toCachedWindow(tmuxWindow: TmuxSession['windows'][number]): CachedTopologyWindow {
  const cached: CachedTopologyWindow = {
    id: tmuxWindow.id,
    index: tmuxWindow.index,
    name: cachedText(tmuxWindow.name) ?? '',
    active: tmuxWindow.active,
    panes: tmuxWindow.panes.slice(0, MAX_CACHED_PANES).map(toCachedPane),
  };
  const customName = cachedText(tmuxWindow.customName);
  if (customName) cached.customName = customName;
  return cached;
}

/** 快照里的会话 → 可落盘的窗口列表；没有窗口即 null（调用方据此删条目） */
export function toCachedWindows(
  session: TmuxSession | null | undefined
): CachedTopologyWindow[] | null {
  const windows = session?.windows;
  if (!windows || windows.length === 0) return null;
  return windows.slice(0, MAX_CACHED_WINDOWS).map(toCachedWindow);
}

/** 实时快照里的会话 → 可落盘的拓扑；没有窗口的会话不值得缓存（返回 null 即删除该条） */
export function toCachedTopology(
  session: TmuxSession | null | undefined,
  now = Date.now()
): CachedTopology | null {
  const windows = toCachedWindows(session);
  return windows ? { savedAt: now, windows } : null;
}

// ---------- 反序列化 ----------

function parsePane(value: unknown): CachedTopologyPane | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) return null;
  const pane: CachedTopologyPane = {
    id: row.id,
    index: typeof row.index === 'number' ? row.index : 0,
    active: row.active === true,
  };
  // 读侧同样截断：早期版本写下的长文本不该在升级后继续吃内存与渲染宽度
  const title = cachedText(row.title);
  if (title) pane.title = title;
  const customName = cachedText(row.customName);
  if (customName) pane.customName = customName;
  const currentCommand = cachedText(row.currentCommand);
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
    name: cachedText(row.name) ?? '',
    active: row.active === true,
    panes,
  };
  const customName = cachedText(row.customName);
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

// ---------- 容量控制 ----------

function serializeCache(devices: Record<string, CachedTopology>): string {
  const payload: PersistedCache = { version: TMUX_TOPOLOGY_CACHE_VERSION, devices };
  return JSON.stringify(payload);
}

/** savedAt 最小的一条（不含 keepDeviceId） */
function oldestDeviceId(
  devices: Record<string, CachedTopology>,
  keepDeviceId: string | null
): string | null {
  let oldest: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [deviceId, topology] of Object.entries(devices)) {
    if (deviceId === keepDeviceId) continue;
    if (topology.savedAt < oldestAt) {
      oldest = deviceId;
      oldestAt = topology.savedAt;
    }
  }
  return oldest;
}

/**
 * 先按条目数、再按序列化长度封顶，都从 savedAt 最旧的开始淘汰（keepDeviceId 优先保留）。
 *
 * 长度预算是硬要求：撑爆配额的键会连累同源下**所有** localStorage 写入方，而这份缓存
 * 只是首屏占位，没资格占那么多。`serialized` 为 null 表示这份表装不下（连最后一台设备
 * 都超预算），调用方据此直接删键，绝不留下一个超标的键。
 */
function fitCacheBudget(
  devices: Record<string, CachedTopology>,
  keepDeviceId: string | null
): { devices: Record<string, CachedTopology>; serialized: string | null } {
  const next = { ...devices };
  while (Object.keys(next).length > MAX_CACHED_DEVICES) {
    const oldest = oldestDeviceId(next, keepDeviceId);
    if (oldest === null) break;
    delete next[oldest];
  }
  while (Object.keys(next).length > 0) {
    const serialized = serializeCache(next);
    if (serialized.length <= MAX_CACHE_CHARS) return { devices: next, serialized };
    const oldest = oldestDeviceId(next, keepDeviceId);
    if (oldest === null) break;
    delete next[oldest];
  }
  return { devices: {}, serialized: null };
}

function readRaw(storage: TopologyCacheStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

// ---------- 每前缀的缓存句柄 ----------

interface TopologyCacheHandle {
  read(now: number): Record<string, CachedTopology>;
  /** 返回是否真的写了盘（指纹未变即跳过） */
  put(deviceId: string, topology: CachedTopology): boolean;
  remove(deviceId: string, now: number): void;
  prune(keep: ReadonlySet<string>, now: number): void;
  /** 丢掉指纹（不动盘上数据）：runtime 卸载后下一次变化要重新落盘 */
  forgetFingerprints(): void;
  reset(): void;
}

function createTopologyCacheHandle(
  storagePrefix: string,
  storage: TopologyCacheStorage
): TopologyCacheHandle {
  const key = tmuxTopologyCacheKey(storagePrefix);
  const fingerprints = new Map<string, string>();
  let devices: Record<string, CachedTopology> | null = null;
  let lastWritten: string | null = null;

  const commit = (keepDeviceId: string | null): void => {
    const budget = fitCacheBudget(devices ?? {}, keepDeviceId);
    devices = budget.devices;
    for (const deviceId of [...fingerprints.keys()]) {
      if (!(deviceId in budget.devices)) fingerprints.delete(deviceId);
    }
    try {
      if (budget.serialized === null) {
        storage.removeItem(key);
        lastWritten = null;
        return;
      }
      storage.setItem(key, budget.serialized);
      lastWritten = budget.serialized;
    } catch {
      // 配额 / 隐私模式：缓存只是首屏占位，写不进去就当没有；指纹一并作废，下次变化再试
      fingerprints.clear();
      lastWritten = null;
    }
  };

  /** TTL 到期的条目就地清掉：内存副本同样受 TTL 约束，不能因为没重新解析就一直留着 */
  const dropExpired = (map: Record<string, CachedTopology>, now: number): void => {
    const expired = Object.keys(map).filter(
      (deviceId) => now - (map[deviceId] as CachedTopology).savedAt > TMUX_TOPOLOGY_TTL_MS
    );
    if (expired.length === 0) return;
    for (const deviceId of expired) {
      delete map[deviceId];
      fingerprints.delete(deviceId);
    }
    commit(null);
  };

  /** 内存副本只在盘上那份被别人（另一个标签页、登出清理）动过时才重新解析 */
  const sync = (now: number): Record<string, CachedTopology> => {
    const raw = readRaw(storage, key);
    if (devices === null || raw !== lastWritten) {
      devices = parseCache(raw, now);
      lastWritten = raw;
      fingerprints.clear();
    }
    dropExpired(devices, now);
    return devices ?? {};
  };

  return {
    read: (now) => sync(now),

    put(deviceId, topology) {
      const map = sync(topology.savedAt);
      const fingerprint = JSON.stringify(topology.windows);
      // 只有 savedAt 在漂：内容一模一样，不值得把整张表重写一遍
      if (map[deviceId] !== undefined && fingerprints.get(deviceId) === fingerprint) return false;
      map[deviceId] = topology;
      fingerprints.set(deviceId, fingerprint);
      commit(deviceId);
      return true;
    },

    remove(deviceId, now) {
      const map = sync(now);
      fingerprints.delete(deviceId);
      if (!(deviceId in map)) return;
      delete map[deviceId];
      commit(null);
    },

    prune(keep, now) {
      const map = sync(now);
      const stale = Object.keys(map).filter((deviceId) => !keep.has(deviceId));
      if (stale.length === 0) return;
      for (const deviceId of stale) {
        delete map[deviceId];
        fingerprints.delete(deviceId);
      }
      commit(null);
    },

    forgetFingerprints() {
      fingerprints.clear();
    },

    reset() {
      fingerprints.clear();
      devices = null;
      lastWritten = null;
    },
  };
}

// 句柄按「存储实例 + 前缀」缓存：生产里 localStorage 是单例，同前缀的读写方共用一份内存副本；
// 测试给每个用例换一份内存 Storage，天然互不干扰。
const handlesByStorage = new WeakMap<TopologyCacheStorage, Map<string, TopologyCacheHandle>>();

function handleFor(storagePrefix: string, storage: TopologyCacheStorage): TopologyCacheHandle {
  let byPrefix = handlesByStorage.get(storage);
  if (!byPrefix) {
    byPrefix = new Map();
    handlesByStorage.set(storage, byPrefix);
  }
  let handle = byPrefix.get(storagePrefix);
  if (!handle) {
    handle = createTopologyCacheHandle(storagePrefix, storage);
    byPrefix.set(storagePrefix, handle);
  }
  return handle;
}

// ---------- 对外读写 ----------

export function readTmuxTopologyCache(
  storagePrefix: string,
  storage: TopologyCacheStorage | null = defaultStorage(),
  now = Date.now()
): TmuxTopologyPlaceholders {
  if (!storage) return {};
  // 拷一层：内部那份是可变的内存副本，不能与调用方（store state）共用同一个引用
  return { ...handleFor(storagePrefix, storage).read(now) };
}

export function writeTmuxTopology(
  storagePrefix: string,
  deviceId: string,
  topology: CachedTopology,
  storage: TopologyCacheStorage | null = defaultStorage()
): void {
  if (!storage || !deviceId) return;
  handleFor(storagePrefix, storage).put(deviceId, topology);
}

export function removeTmuxTopology(
  storagePrefix: string,
  deviceId: string,
  storage: TopologyCacheStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage || !deviceId) return;
  handleFor(storagePrefix, storage).remove(deviceId, now);
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
  handleFor(storagePrefix, storage).prune(new Set(keepDeviceIds), now);
}

/** 登出 / 换账号：整份丢掉，别把上一位用户的窗口名留给下一位 */
export function clearTmuxTopologyCache(
  storagePrefix: string,
  storage: TopologyCacheStorage | null = defaultStorage()
): void {
  if (!storage) return;
  handleFor(storagePrefix, storage).reset();
  try {
    storage.removeItem(tmuxTopologyCacheKey(storagePrefix));
  } catch {
    // 存储不可用时无事可做
  }
}

/**
 * 内部使用（写通模块）：取该前缀的缓存句柄。`storage` 缺省即浏览器 localStorage，
 * 存储不可用时返回 null，调用方据此整条跳过。
 */
export function topologyCacheHandle(
  storagePrefix: string,
  storage: TopologyCacheStorage | null | undefined
): TopologyCacheHandle | null {
  const resolved = storage === undefined ? defaultStorage() : storage;
  return resolved ? handleFor(storagePrefix, resolved) : null;
}
