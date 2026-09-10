// 会话作废（登出 / 换账号 / 凭证失效）时顺手清掉按节点前缀落盘的 tmux 窗口拓扑缓存：
// 前缀由各 node runtime 决定，这里不依赖节点列表，直接按键后缀扫一遍 localStorage。

import { tmuxTopologyCacheKey } from '@vibeterm/stores';

const TOPOLOGY_KEY_SUFFIX = tmuxTopologyCacheKey('');

export function clearLocalTopologyCaches(storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.endsWith(TOPOLOGY_KEY_SUFFIX)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
  } catch {
    // 存储不可用时无事可做
  }
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
