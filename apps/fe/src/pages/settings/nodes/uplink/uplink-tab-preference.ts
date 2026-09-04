// 本机卡上「接入 Hub / 接入中继」两个 tab 的选中规则。
//
// 已经有上级链路时按真实形态选（中继模式选中继、hub 模式选 Hub），没有上级时才用用户上次
// 点过的那个。真实形态**不写回**记忆：一台机器接了中继不代表它以后想从中继那边开始看。

import type { RelayUplinkMode } from '@tmex/api-client/relay/tenant-api';

export type UplinkTab = 'hub' | 'relay';

export const UPLINK_TAB_STORAGE_KEY = 'tmex.nodes.uplink-tab';

export interface UplinkTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 无 DOM 的测试环境没有 localStorage；隐私模式下访问它还会直接抛。 */
export function browserUplinkTabStorage(): UplinkTabStorage | null {
  try {
    return (globalThis as { localStorage?: UplinkTabStorage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function isUplinkTab(value: unknown): value is UplinkTab {
  return value === 'hub' || value === 'relay';
}

export function readUplinkTab(
  storage: UplinkTabStorage | null = browserUplinkTabStorage()
): UplinkTab {
  try {
    const raw = storage?.getItem(UPLINK_TAB_STORAGE_KEY) ?? null;
    return isUplinkTab(raw) ? raw : 'hub';
  } catch {
    return 'hub';
  }
}

export function writeUplinkTab(
  tab: UplinkTab,
  storage: UplinkTabStorage | null = browserUplinkTabStorage()
): void {
  try {
    storage?.setItem(UPLINK_TAB_STORAGE_KEY, tab);
  } catch {
    // 隐私模式 / 配额耗尽：记不住就算了，下次回到默认的 Hub tab。
  }
}

/** 派生出的初始 tab；用户当场点过的选择优先于它。 */
export function deriveUplinkTab(mode: RelayUplinkMode, remembered: UplinkTab): UplinkTab {
  if (mode === 'relay') return 'relay';
  if (mode === 'hub') return 'hub';
  return remembered;
}
