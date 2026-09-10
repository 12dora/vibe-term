// 每个节点最近一次成功拿到的设备列表快照，落在 localStorage（按 runtimeNodeId 分键）。
// 节点离线时（含刷新后冷启动）设备页仍能渲染完整卡片；没有快照才退回服务端节点 inventory
// 里的简化设备（只有 id / name）。
//
// 一个小索引键记录每个节点快照的 updatedAt：条目上限 MAX_SNAPSHOTS（LRU 淘汰最旧的），
// 写入撞上配额时先淘汰最旧的再重试一次；节点从 mesh 列表消失后由页面调用 prune 清掉。

import type { DeviceWithRuntime, DevicesResponse } from '@vibeterm/api-client';
import type { Device } from '@vibeterm/shared';

const KEY_PREFIX = 'vibeterm:device-snapshot:';
const INDEX_KEY = 'vibeterm:device-snapshot-index';
// 改名前的键。快照只是离线兜底，节点在线时会立刻重建，因此不搬运，直接清掉旧的那份。
const LEGACY_KEY_PREFIX = 'tmex:device-snapshot:';
const LEGACY_INDEX_KEY = 'tmex:device-snapshot-index';
export const MAX_SNAPSHOTS = 32;

export interface DeviceSnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type SnapshotIndex = Record<string, number>;

function defaultStorage(): DeviceSnapshotStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function deviceSnapshotKey(runtimeNodeId: string): string {
  return `${KEY_PREFIX}${runtimeNodeId}`;
}

/** 快照只留渲染卡片需要的字段，凭证之类的敏感字段一律不落盘 */
export function toSnapshotDevice(device: Device): Device {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    host: device.host,
    port: device.port,
    username: device.username,
    sshConfigRef: device.sshConfigRef,
    session: device.session,
    authMode: device.authMode,
    defaultWorkingDir: device.defaultWorkingDir,
    sortOrder: device.sortOrder,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

/**
 * 改名遗留的旧快照：只是离线兜底缓存，节点一在线就会整份重写，没有搬运价值，直接清掉。
 * 旧索引列出了全部条目键，据此逐个删；索引本身读不到时旧条目就留给浏览器自己回收。
 */
function dropLegacyDeviceSnapshots(storage: DeviceSnapshotStorage): void {
  try {
    const raw = storage.getItem(LEGACY_INDEX_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const nodeId of Object.keys(parsed as Record<string, unknown>)) {
        storage.removeItem(`${LEGACY_KEY_PREFIX}${nodeId}`);
      }
    }
    storage.removeItem(LEGACY_INDEX_KEY);
  } catch {
    // 存储不可用 / 旧索引是脏数据：残留的旧键不影响新逻辑
  }
}

function readIndex(storage: DeviceSnapshotStorage): SnapshotIndex {
  try {
    const raw = storage.getItem(INDEX_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const index: SnapshotIndex = {};
    for (const [nodeId, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (nodeId && typeof at === 'number') index[nodeId] = at;
    }
    return index;
  } catch {
    return {};
  }
}

function writeIndex(storage: DeviceSnapshotStorage, index: SnapshotIndex): void {
  try {
    if (Object.keys(index).length === 0) storage.removeItem(INDEX_KEY);
    else storage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // 索引写不进去只影响淘汰顺序，不影响读取
  }
}

function removeEntry(storage: DeviceSnapshotStorage, index: SnapshotIndex, nodeId: string): void {
  try {
    storage.removeItem(deviceSnapshotKey(nodeId));
  } catch {
    // ignore
  }
  delete index[nodeId];
}

/** 最旧的一条（updatedAt 最小；不含 exceptNodeId） */
function oldestNodeId(index: SnapshotIndex, exceptNodeId: string): string | null {
  let oldest: string | null = null;
  for (const [nodeId, at] of Object.entries(index)) {
    if (nodeId === exceptNodeId) continue;
    if (oldest === null || at < (index[oldest] ?? 0)) oldest = nodeId;
  }
  return oldest;
}

export function writeDeviceSnapshot(
  runtimeNodeId: string,
  devices: readonly Device[],
  storage: DeviceSnapshotStorage | null = defaultStorage(),
  now = Date.now()
): void {
  if (!storage || !runtimeNodeId) return;
  dropLegacyDeviceSnapshots(storage);
  const index = readIndex(storage);
  const payload = JSON.stringify(devices.map(toSnapshotDevice));
  const key = deviceSnapshotKey(runtimeNodeId);

  // 先按上限腾位置（新条目不算在内），再写；撞配额就淘汰最旧的一条重试一次
  while (Object.keys(index).filter((nodeId) => nodeId !== runtimeNodeId).length >= MAX_SNAPSHOTS) {
    const oldest = oldestNodeId(index, runtimeNodeId);
    if (oldest === null) break;
    removeEntry(storage, index, oldest);
  }
  const attempt = (): boolean => {
    try {
      storage.setItem(key, payload);
      return true;
    } catch {
      return false;
    }
  };
  let written = attempt();
  if (!written) {
    const oldest = oldestNodeId(index, runtimeNodeId);
    if (oldest !== null) {
      removeEntry(storage, index, oldest);
      written = attempt();
    }
  }
  if (!written) {
    writeIndex(storage, index);
    return;
  }
  index[runtimeNodeId] = now;
  writeIndex(storage, index);
}

/** 同一个 id 只留第一条：重复 id 会在卡片网格里渲染出两张一样的卡片 */
function dedupeById(devices: readonly Device[]): Device[] {
  const byId = new Map<string, Device>();
  for (const device of devices) {
    if (!byId.has(device.id)) byId.set(device.id, device);
  }
  return [...byId.values()];
}

function isDevice(value: unknown): value is Device {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    (row.type === 'local' || row.type === 'ssh') &&
    typeof row.sortOrder === 'number'
  );
}

export function readDeviceSnapshot(
  runtimeNodeId: string,
  storage: DeviceSnapshotStorage | null = defaultStorage()
): Device[] | null {
  if (!storage) return null;
  dropLegacyDeviceSnapshots(storage);
  try {
    const raw = storage.getItem(deviceSnapshotKey(runtimeNodeId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return dedupeById(parsed.filter(isDevice));
  } catch {
    return null;
  }
}

export function clearDeviceSnapshot(
  runtimeNodeId: string,
  storage: DeviceSnapshotStorage | null = defaultStorage()
): void {
  if (!storage) return;
  const index = readIndex(storage);
  removeEntry(storage, index, runtimeNodeId);
  writeIndex(storage, index);
}

/** 只保留仍在 mesh 列表里的节点的快照，其余（含索引之外遗留的键）一律删掉 */
export function pruneDeviceSnapshots(
  keepNodeIds: Iterable<string>,
  storage: DeviceSnapshotStorage | null = defaultStorage()
): void {
  if (!storage) return;
  const keep = new Set(keepNodeIds);
  const index = readIndex(storage);
  for (const nodeId of Object.keys(index)) {
    if (!keep.has(nodeId)) removeEntry(storage, index, nodeId);
  }
  writeIndex(storage, index);
}

/**
 * 这个 localStorage 键是不是设备快照（含索引与改名前的旧键）。
 * 登出 / 换账号 / 凭证失效时由宿主按前缀整片清掉（见 `auth/logout-local-caches.ts`）：
 * 快照现在是首帧占位数据，留着会让上一个账号的设备名一直画到 `/api/devices` 回来。
 */
export function isDeviceSnapshotKey(key: string): boolean {
  return (
    key.startsWith(KEY_PREFIX) ||
    key === INDEX_KEY ||
    key.startsWith(LEGACY_KEY_PREFIX) ||
    key === LEGACY_INDEX_KEY
  );
}

/** 快照里没有运行时状态字段（最近在线、错误、tmux 可用性），补成「未知」即可参与渲染。 */
function toRuntimeDevice(device: Device): DeviceWithRuntime {
  return {
    ...device,
    lastSeenAt: null,
    lastError: null,
    lastErrorType: null,
    tmuxAvailable: false,
  };
}

/**
 * `['devices']` 查询的首帧占位。
 *
 * 用 `placeholderData` 而不是 `initialData`：占位数据不进缓存、`isPlaceholderData` 为真，
 * 请求照常立刻发出，且调用方能据此把连接 / 订阅这类副作用挡在真实列表到达之前
 * （与侧边栏的 `deviceQueryFlags` 同一套语义）。快照为空时返回 undefined，照常走加载态。
 */
export function deviceSnapshotPlaceholder(
  runtimeNodeId: string,
  storage: DeviceSnapshotStorage | null = defaultStorage()
): DevicesResponse | undefined {
  const devices = readDeviceSnapshot(runtimeNodeId, storage);
  if (!devices || devices.length === 0) return undefined;
  return { devices: devices.map(toRuntimeDevice) };
}

/** 索引里的节点 id（测试与调试用） */
export function listDeviceSnapshotNodeIds(
  storage: DeviceSnapshotStorage | null = defaultStorage()
): string[] {
  if (!storage) return [];
  return Object.keys(readIndex(storage));
}

/** 节点 inventory（`{ devices: [{ id, name }] }`）→ 只够渲染卡片的最小设备 DTO */
export function inventoryFallbackDevices(inventory: unknown): Device[] {
  if (!inventory || typeof inventory !== 'object') return [];
  const devices = (inventory as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return [];
  const out: Device[] = [];
  const seen = new Set<string>();
  devices.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const row = item as { id?: unknown; name?: unknown; type?: unknown };
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) return;
    seen.add(row.id);
    out.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name ? row.name : row.id,
      type: row.type === 'ssh' ? 'ssh' : 'local',
      authMode: 'auto',
      sortOrder: index,
      createdAt: '',
      updatedAt: '',
    });
  });
  return out;
}

/**
 * 离线时的卡片数据来源：本地快照优先，其次节点 inventory。
 * 两者**不合并**——同一台设备在快照与 inventory 里各有一份，合并会渲染出两张一样的卡片。
 */
export function offlineDevices(
  runtimeNodeId: string,
  inventory: unknown,
  storage: DeviceSnapshotStorage | null = defaultStorage()
): Device[] {
  return readDeviceSnapshot(runtimeNodeId, storage) ?? inventoryFallbackDevices(inventory);
}
