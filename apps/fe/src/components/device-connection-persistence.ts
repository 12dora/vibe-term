/** 仅需 get/set 的 Storage 子集，便于纯函数在无 DOM 环境下被测试 */
export interface DeviceIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 持久化的设备连接意图存储键，按 runtime 的 storagePrefix 命名空间隔离（self 前缀为空串）。
 * 载荷格式固定为 `string[]`；若将来需要变更载荷结构，应改用新键名而非原地升级，
 * 避免旧版本读到无法解析的数据。
 */
export function connectedDevicesKey(storagePrefix: string): string {
  return `${storagePrefix}tmex:connectedDevices`;
}

export function disconnectedDevicesKey(storagePrefix: string): string {
  return `${storagePrefix}tmex:disconnectedDevices`;
}

function resolveStorage(storage?: DeviceIdStorage | null): DeviceIdStorage | null {
  if (storage) return storage;
  if (storage === null) return null;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function readPersistedIds(key: string, storage?: DeviceIdStorage | null): Set<string> {
  const target = resolveStorage(storage);
  if (!target) return new Set<string>();
  try {
    const raw = target.getItem(key);
    if (!raw) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter(isNonEmptyString));
  } catch {
    return new Set<string>();
  }
}

export function writePersistedIds(
  key: string,
  ids: Iterable<string>,
  storage?: DeviceIdStorage | null
): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(key, JSON.stringify([...ids]));
  } catch {
    // 忽略 localStorage 写入失败（隐私模式 / 配额）
  }
}

/** 清理已删除设备；无变化时返回原引用，避免 setState 触发多余渲染 */
export function pruneUnknownDeviceIds(
  ids: Set<string>,
  knownDeviceIds: ReadonlySet<string>
): Set<string> {
  const next = new Set<string>();
  let changed = false;
  for (const id of ids) {
    if (knownDeviceIds.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : ids;
}

export function withDeviceId(ids: ReadonlySet<string>, deviceId: string): Set<string> | null {
  if (ids.has(deviceId)) return null;
  const next = new Set(ids);
  next.add(deviceId);
  return next;
}

export function withoutDeviceId(ids: ReadonlySet<string>, deviceId: string): Set<string> | null {
  if (!ids.has(deviceId)) return null;
  const next = new Set(ids);
  next.delete(deviceId);
  return next;
}
