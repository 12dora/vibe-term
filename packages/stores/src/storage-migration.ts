// 改名 tmex → VibeTerm 的一次性存储键迁移：旧键有值且新键还没有时，把值搬到新键，随后删掉旧键。
// 幂等（旧键删除后再调用是空操作），且任何一步失败都不能影响调用方启动。

export interface SyncKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function migrateStorageKey(
  storage: SyncKeyValueStorage | undefined | null,
  oldKey: string,
  newKey: string
): void {
  if (!storage || oldKey === newKey) {
    return;
  }
  try {
    const legacy = storage.getItem(oldKey);
    if (legacy === null) {
      return;
    }
    if (storage.getItem(newKey) === null) {
      storage.setItem(newKey, legacy);
    }
    storage.removeItem(oldKey);
  } catch {
    // 存储不可用（隐私模式 / 配额 / 跨域限制）时静默降级：迁移失败最多是丢一次偏好，不能阻断启动
  }
}

/** 浏览器 localStorage 的迁移入口；非浏览器环境（SSR / 测试 node 环境）直接跳过。 */
export function migrateLocalStorageKey(oldKey: string, newKey: string): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }
    migrateStorageKey(localStorage, oldKey, newKey);
  } catch {
    // 访问 localStorage 本身就可能抛（部分浏览器禁用站点数据）
  }
}
