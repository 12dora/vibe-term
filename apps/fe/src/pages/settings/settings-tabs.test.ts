// 设置标签注册表：派生结构必须与收口前的口径一致（预热顺序、标签栏顺序、loader 引用）。

import { describe, expect, test } from 'bun:test';
import {
  Bell,
  Globe,
  Monitor,
  Network,
  RadioTower,
  Settings as SettingsIcon,
  Share2,
  Sparkles,
} from 'lucide-react';
import { PREFETCHABLE_TABS } from './data-prefetch';
import {
  prefetchAiSettings,
  prefetchNodes,
  prefetchRemoteAccess,
  prefetchShare,
  prefetchSiteSettings,
  prefetchTerminalSettings,
} from './settings-prefetch';
import {
  OPTIONAL_SETTINGS_TABS,
  SETTINGS_TABS,
  SETTINGS_TAB_BAR,
  SETTINGS_TAB_SPECS,
  TABS_USING_SITE_SETTINGS,
  TAB_CHUNK_LOADERS,
  chunkPreloadOrder,
  loadAISettingsTab,
  loadGeneralSettingsTab,
  loadNodesTab,
  loadNotificationSettingsTab,
  loadRelayTab,
  loadRemoteAccessTab,
  loadShareTab,
  loadTerminalSettingsTab,
  settingsTabBarItems,
  settingsTabFromParam,
} from './settings-tabs';

const PRELOAD_IDS = [
  'general',
  'nodes',
  'share',
  'notifications',
  'ai',
  'terminal',
  'remoteAccess',
] as const;

const BAR_IDS = [
  'general',
  'terminal',
  'remoteAccess',
  'nodes',
  'share',
  'notifications',
  'ai',
] as const;

const BAR_LABELS = [
  'settings.tabGroup.general',
  'settings.tabGroup.terminal',
  'settings.tabGroup.remoteAccess',
  'settings.tabGroup.nodes',
  'settings.tabGroup.share',
  'settings.tabGroup.notifications',
  'settings.tabGroup.ai',
] as const;

const BAR_ICONS = [SettingsIcon, Monitor, Globe, Network, Share2, Bell, Sparkles];

const LOADERS = {
  general: loadGeneralSettingsTab,
  nodes: loadNodesTab,
  notifications: loadNotificationSettingsTab,
  ai: loadAISettingsTab,
  terminal: loadTerminalSettingsTab,
  remoteAccess: loadRemoteAccessTab,
  relay: loadRelayTab,
  share: loadShareTab,
} as const;

describe('SETTINGS_TAB_SPECS 派生结构', () => {
  test('空闲预热顺序（不含 optional）与收口前 SETTINGS_TABS 一致', () => {
    expect(SETTINGS_TABS).toEqual([...PRELOAD_IDS]);
  });

  test('optional 只有中继', () => {
    expect(OPTIONAL_SETTINGS_TABS).toEqual(['relay']);
  });

  test('标签栏展示顺序与收口前 SETTINGS_TAB_BAR 一致', () => {
    expect(SETTINGS_TAB_BAR.map((item) => item.value)).toEqual([...BAR_IDS]);
    expect(SETTINGS_TAB_BAR.map((item) => item.labelKey)).toEqual([...BAR_LABELS]);
    expect(SETTINGS_TAB_BAR.map((item) => item.icon)).toEqual(BAR_ICONS);
  });

  test('中继标签文案/图标仍是原来那一套，插在「多节点互联」右侧', () => {
    const relay = SETTINGS_TAB_SPECS.find((spec) => spec.id === 'relay');
    expect(relay?.labelKey).toBe('relay.admin.tabLabel');
    expect(relay?.icon).toBe(RadioTower);
    expect(settingsTabBarItems(false).map((item) => item.value)).toEqual([...BAR_IDS]);
    expect(settingsTabBarItems(true).map((item) => item.value)).toEqual([
      'general',
      'terminal',
      'remoteAccess',
      'nodes',
      'relay',
      'share',
      'notifications',
      'ai',
    ]);
  });

  test('吃站点设置草稿的仍是通用与通知', () => {
    expect([...TABS_USING_SITE_SETTINGS].sort()).toEqual(['general', 'notifications']);
  });

  test('每个 loader 与 lazyChunk 用的是同一引用', () => {
    for (const spec of SETTINGS_TAB_SPECS) {
      expect(TAB_CHUNK_LOADERS[spec.id]).toBe(spec.loader);
      expect(TAB_CHUNK_LOADERS[spec.id]).toBe(LOADERS[spec.id]);
    }
  });

  test('可预取标签与收口前 PREFETCHABLE_TABS 集合一致，且 spec.prefetch 就是那份函数', () => {
    expect([...PREFETCHABLE_TABS].sort()).toEqual(
      ['ai', 'general', 'nodes', 'remoteAccess', 'share', 'terminal'].sort()
    );
    const withPrefetch = SETTINGS_TAB_SPECS.filter((spec) => spec.prefetch).map((spec) => spec.id);
    expect(withPrefetch.sort()).toEqual([...PREFETCHABLE_TABS].sort());
    expect(SETTINGS_TAB_SPECS.find((spec) => spec.id === 'general')?.prefetch).toBe(
      prefetchSiteSettings
    );
    expect(SETTINGS_TAB_SPECS.find((spec) => spec.id === 'ai')?.prefetch).toBe(prefetchAiSettings);
    expect(SETTINGS_TAB_SPECS.find((spec) => spec.id === 'terminal')?.prefetch).toBe(
      prefetchTerminalSettings
    );
    expect(SETTINGS_TAB_SPECS.find((spec) => spec.id === 'nodes')?.prefetch).toBe(prefetchNodes);
    expect(SETTINGS_TAB_SPECS.find((spec) => spec.id === 'remoteAccess')?.prefetch).toBe(
      prefetchRemoteAccess
    );
    expect(SETTINGS_TAB_SPECS.find((spec) => spec.id === 'share')?.prefetch).toBe(prefetchShare);
  });
});

describe('chunkPreloadOrder', () => {
  test('排除当前标签，其余按预热顺序各出现一次，且是 TAB_CHUNK_LOADERS 里那份引用', () => {
    expect(chunkPreloadOrder('general')).toEqual(
      PRELOAD_IDS.filter((id) => id !== 'general').map((id) => TAB_CHUNK_LOADERS[id])
    );
    expect(chunkPreloadOrder('nodes')[0]).toBe(TAB_CHUNK_LOADERS.general);
    expect(chunkPreloadOrder('relay')).toHaveLength(PRELOAD_IDS.length);
  });
});

describe('settingsTabFromParam', () => {
  test('注册表里的 id 原样返回，其它回通用', () => {
    for (const spec of SETTINGS_TAB_SPECS) {
      expect(settingsTabFromParam(spec.id)).toBe(spec.id);
    }
    expect(settingsTabFromParam(null)).toBe('general');
    expect(settingsTabFromParam('bogus')).toBe('general');
  });
});
