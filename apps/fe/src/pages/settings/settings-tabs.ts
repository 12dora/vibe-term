// 设置页标签的唯一注册表。加标签只改这一份：id / 文案 / 图标 / chunk loader / 是否门禁 /
// 悬停预取 / 是否吃站点设置草稿，标签栏、空闲预热、深链都从这里派生。
//
// loader 必须是具名函数：`lazyChunk` 与 `preloadChunk` 靠同一引用命中同一个 chunk，
// 绝不能在预热侧另写一条静态 import（会把整块面板打回入口 chunk）。
//
// 本文件带 i18n key，只能被设置页（lazy route）引用；侧栏悬停预取走 `data-prefetch.ts`，
// 那边只拿 `settings-prefetch.ts` 里同一组 prefetch 函数，避免 key 漏进入口 core 包。

import type { ChunkPreloadTarget } from '@/lib/chunk-preload';
import {
  Bell,
  Globe,
  type LucideIcon,
  Monitor,
  Network,
  RadioTower,
  Settings as SettingsIcon,
  Share2,
  Sparkles,
} from 'lucide-react';
import {
  type TabPrefetchFn,
  prefetchAiSettings,
  prefetchNodes,
  prefetchRemoteAccess,
  prefetchShare,
  prefetchSiteSettings,
  prefetchTerminalSettings,
} from './settings-prefetch';

export const loadGeneralSettingsTab = () =>
  import('./general-settings-tab').then((m) => m.GeneralSettingsTab);
export const loadNodesTab = () => import('./nodes/nodes-tab').then((m) => m.NodesTab);
export const loadNotificationSettingsTab = () =>
  import('./notification-settings-tab').then((m) => m.NotificationSettingsTab);
export const loadAISettingsTab = () => import('./ai-settings-tab').then((m) => m.AISettingsTab);
export const loadTerminalSettingsTab = () =>
  import('@vibeterm/panels/settings/terminal').then((m) => m.TerminalSettingsTab);
export const loadRemoteAccessTab = () =>
  import('./remote-access/remote-access-tab').then((m) => m.RemoteAccessTab);
export const loadRelayTab = () => import('./relay/relay-tab').then((m) => m.RelayTab);
export const loadShareTab = () => import('./share/share-tab').then((m) => m.ShareTab);

export type SettingsTab =
  | 'general'
  | 'nodes'
  | 'notifications'
  | 'ai'
  | 'terminal'
  | 'remoteAccess'
  | 'relay'
  | 'share';

export interface SettingsTabSpec {
  id: SettingsTab;
  labelKey: string;
  icon: LucideIcon;
  loader: ChunkPreloadTarget;
  optional?: boolean;
  prefetch?: TabPrefetchFn;
  usesSiteSettings?: boolean;
  /** 标签栏位次；与数组顺序（空闲预热）独立。optional 标签走 barInsertAfter。 */
  barOrder?: number;
  barInsertAfter?: SettingsTab;
}

/**
 * 数组顺序 = 空闲预热顺序（optional 不进预热池）。
 * 标签栏按 `barOrder` 排，中继插在 `barInsertAfter` 所指标签右侧。
 */
export const SETTINGS_TAB_SPECS = [
  {
    id: 'general',
    labelKey: 'settings.tabGroup.general',
    icon: SettingsIcon,
    loader: loadGeneralSettingsTab,
    usesSiteSettings: true,
    barOrder: 0,
    prefetch: prefetchSiteSettings,
  },
  {
    id: 'nodes',
    labelKey: 'settings.tabGroup.nodes',
    icon: Network,
    loader: loadNodesTab,
    barOrder: 3,
    prefetch: prefetchNodes,
  },
  {
    id: 'share',
    labelKey: 'settings.tabGroup.share',
    icon: Share2,
    loader: loadShareTab,
    barOrder: 4,
    prefetch: prefetchShare,
  },
  {
    id: 'notifications',
    labelKey: 'settings.tabGroup.notifications',
    icon: Bell,
    loader: loadNotificationSettingsTab,
    usesSiteSettings: true,
    barOrder: 5,
  },
  {
    id: 'ai',
    labelKey: 'settings.tabGroup.ai',
    icon: Sparkles,
    loader: loadAISettingsTab,
    barOrder: 6,
    prefetch: prefetchAiSettings,
  },
  {
    id: 'terminal',
    labelKey: 'settings.tabGroup.terminal',
    icon: Monitor,
    loader: loadTerminalSettingsTab,
    barOrder: 1,
    prefetch: prefetchTerminalSettings,
  },
  {
    id: 'remoteAccess',
    labelKey: 'settings.tabGroup.remoteAccess',
    icon: Globe,
    loader: loadRemoteAccessTab,
    barOrder: 2,
    prefetch: prefetchRemoteAccess,
  },
  {
    id: 'relay',
    labelKey: 'relay.admin.tabLabel',
    icon: RadioTower,
    loader: loadRelayTab,
    optional: true,
    barInsertAfter: 'nodes',
  },
] satisfies readonly SettingsTabSpec[];

export type SettingsTabBarItem = {
  value: SettingsTab;
  labelKey: string;
  icon: LucideIcon;
};

function toBarItem(spec: SettingsTabSpec): SettingsTabBarItem {
  return { value: spec.id, labelKey: spec.labelKey, icon: spec.icon };
}

/** 每台机器都有的标签：空闲预热与 `chunkPreloadOrder` 只认这一组。 */
export const SETTINGS_TABS: SettingsTab[] = SETTINGS_TAB_SPECS.filter((spec) => !spec.optional).map(
  (spec) => spec.id
);

/**
 * 按角色出现的标签：`relay` 只在本机带 relay 角色时才有（门禁见 `useRelayAvailability`）。
 * **不进** `SETTINGS_TABS`——绝大多数机器不是中继，没理由让每次进设置页都把这块 chunk 拖下来。
 */
export const OPTIONAL_SETTINGS_TABS: SettingsTab[] = SETTINGS_TAB_SPECS.filter(
  (spec) => spec.optional
).map((spec) => spec.id);

export const TAB_CHUNK_LOADERS = Object.fromEntries(
  SETTINGS_TAB_SPECS.map((spec) => [spec.id, spec.loader])
) as Record<SettingsTab, ChunkPreloadTarget>;

/** 用 `SiteSettingsForm` 的标签；其余标签下不必拉 `/api/settings/site`。 */
export const TABS_USING_SITE_SETTINGS: ReadonlySet<SettingsTab> = new Set(
  SETTINGS_TAB_SPECS.filter((spec) => spec.usesSiteSettings).map((spec) => spec.id)
);

/** 标签栏展示顺序（不含 optional）；与空闲预热顺序无关。 */
export const SETTINGS_TAB_BAR: SettingsTabBarItem[] = SETTINGS_TAB_SPECS.filter(
  (spec) => !spec.optional
)
  .slice()
  .sort((a, b) => (a.barOrder ?? 0) - (b.barOrder ?? 0))
  .map(toBarItem);

const TAB_ID_SET: ReadonlySet<string> = new Set(SETTINGS_TAB_SPECS.map((spec) => spec.id));

/** 预热顺序：当前标签自己在加载，排除掉；其余按注册表数组顺序逐个排队。 */
export function chunkPreloadOrder(activeTab: SettingsTab): ChunkPreloadTarget[] {
  return SETTINGS_TABS.filter((tab) => tab !== activeTab).map((tab) => TAB_CHUNK_LOADERS[tab]);
}

export function settingsTabBarItems(showRelay: boolean): SettingsTabBarItem[] {
  const items = [...SETTINGS_TAB_BAR];
  if (!showRelay) return items;
  for (const spec of SETTINGS_TAB_SPECS) {
    if (!spec.optional) continue;
    const after = spec.barInsertAfter;
    const at = (after ? items.findIndex((item) => item.value === after) : items.length - 1) + 1;
    items.splice(at, 0, toBarItem(spec));
  }
  return items;
}

export function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && TAB_ID_SET.has(value);
}

/** `?tab=` 的唯一解释处：缺失或不认识一律回「通用」。 */
export function settingsTabFromParam(value: string | null): SettingsTab {
  return isSettingsTab(value) ? value : 'general';
}
