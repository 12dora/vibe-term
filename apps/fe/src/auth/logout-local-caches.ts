// 会话被**明确**作废（换账号 / 凭证失效 / 全量重置）时清掉按 node 缓存的那几样东西：
//  - 各 node 前缀下的 tmux 窗口拓扑缓存；
//  - 各 node 的设备列表快照（含索引），它现在是设备列表的首帧占位数据——不清的话换账号后
//    上一个账号的设备名会一直画到 `/api/devices` 回来；
//  - 内存里按 node 缓存的带门 ApiClient（`resetGatedNodeApiClients`）。
// 落盘那两类的前缀由各 node runtime 决定，这里不依赖节点列表，直接扫一遍 localStorage 的键。
//
// **只由显式作废路径调用**：会话到期后紧跟着静默重登，那不是换账号，把首帧占位一起抹掉
// 只会让每次过期都退化成一次冷启动。

import { resetGatedNodeApiClients } from '@/node/node-session-probe';
import { isDeviceSnapshotKey } from '@/pages/devices/device-snapshot-store';
import { tmuxTopologyCacheKey } from '@vibeterm/stores';

const TOPOLOGY_KEY_SUFFIX = tmuxTopologyCacheKey('');

export function clearLocalDeviceCaches(storage: Storage | null = defaultStorage()): void {
  // 内存里那份按 node 缓存的带门 ApiClient 同样是上一个账号的（含它的延迟 EWMA）。
  resetGatedNodeApiClients();
  if (!storage) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key) continue;
      if (key.endsWith(TOPOLOGY_KEY_SUFFIX) || isDeviceSnapshotKey(key)) stale.push(key);
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
