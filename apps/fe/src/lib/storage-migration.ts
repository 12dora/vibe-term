// 改名 tmex → VibeTerm 的浏览器持久化迁移。单键搬运复用 `@vibeterm/stores` 的
// `migrateStorageKey`，这里只补两个 fe 侧才需要的形态：按前缀批量搬运、按前缀清理。

import { type SyncKeyValueStorage, migrateStorageKey } from '@vibeterm/stores';

/** 能枚举键的 Storage 子集；假存储只要实现 `length` + `key()` 即可参与迁移。 */
export type EnumerableStorage = SyncKeyValueStorage & {
  readonly length: number;
  key(index: number): string | null;
};

function enumerateKeys(storage: EnumerableStorage, prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** 把 `oldPrefix` 下的所有键搬到 `newPrefix`（键名其余部分不变）。 */
export function migrateStorageKeyPrefix(
  storage: EnumerableStorage | undefined | null,
  oldPrefix: string,
  newPrefix: string
): void {
  if (!storage || oldPrefix === newPrefix) return;
  try {
    for (const key of enumerateKeys(storage, oldPrefix)) {
      migrateStorageKey(storage, key, newPrefix + key.slice(oldPrefix.length));
    }
  } catch {
    // 存储不可用时静默降级：迁移失败最多丢一次本地状态，不能阻断页面
  }
}

/** 丢弃 `prefix` 下的所有键；用于改名后没有搬运价值的纯缓存。 */
export function dropStorageKeyPrefix(
  storage: EnumerableStorage | undefined | null,
  prefix: string
): void {
  if (!storage) return;
  try {
    for (const key of enumerateKeys(storage, prefix)) {
      storage.removeItem(key);
    }
  } catch {
    // 同上
  }
}

/** 浏览器 localStorage；非浏览器环境（测试 / SSR）返回 null。 */
export function browserEnumerableStorage(): EnumerableStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
