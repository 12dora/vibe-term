// 冷启动占位树：缓存拓扑的灰显渲染 + 点击行为。
// bun test 无 DOM，结构断言走 react-dom/server 静态渲染（与 device-row.test.tsx 同一套做法），
// 点击行为则断言抽出来的纯函数 openStalePane。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18N_RESOURCES } from '@vibeterm/shared';
import type { CachedTopology } from '@vibeterm/stores';
import { createAppRuntime } from '@vibeterm/stores';
import { RuntimeProvider } from '@vibeterm/stores/react';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { StaleTopologyList, openStalePane } from './stale-topology-list';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const TOPOLOGY: CachedTopology = {
  savedAt: Date.now(),
  windows: [
    {
      id: '@1',
      index: 0,
      name: 'zsh',
      active: true,
      customName: '编辑',
      panes: [{ id: '%1', index: 0, active: true, currentCommand: 'nvim' }],
    },
    {
      id: '@2',
      index: 1,
      name: 'bash',
      active: false,
      panes: [
        { id: '%2', index: 0, active: true, title: '构建' },
        { id: '%3', index: 1, active: false, title: '日志' },
      ],
    },
  ],
};

let storageSeq = 0;

function renderList(): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `stale-topology-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <StaleTopologyList deviceId="dev-1" topology={TOPOLOGY} onPaneClick={() => undefined} />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('StaleTopologyList 渲染', () => {
  test('按缓存拓扑渲染窗口与 pane 行，并挂上「上次会话」提示', () => {
    const html = renderList();

    expect(html).toContain('data-testid="stale-topology-dev-1"');
    expect(html).toContain('data-testid="stale-window-item-@1"');
    expect(html).toContain('data-testid="stale-window-item-@2"');
    // 单 pane 窗口展示窗口标题，多 pane 窗口才把 pane 拆成子行
    expect(html).toContain('编辑');
    expect(html).toContain('data-testid="stale-pane-item-%2"');
    expect(html).toContain('data-testid="stale-pane-item-%3"');
    expect(html).not.toContain('data-testid="stale-pane-item-%1"');
    expect(html).toContain(i18n.t('sidebar.topologyStale'));
  });

  test('整棵占位树灰显（muted + 降不透明度）', () => {
    const html = renderList();

    expect(html).toContain('opacity-70');
    expect(html).toContain('text-muted-foreground');
  });

  test('占位行不挂拖拽手柄与操作菜单', () => {
    const html = renderList();

    expect(html).not.toContain('data-testid="window-menu-@1"');
    expect(html).not.toContain('data-testid="pane-close-%2"');
    expect(html).not.toContain(i18n.t('window.dragHandle'));
  });
});

describe('openStalePane', () => {
  function deps(overrides: Partial<Parameters<typeof openStalePane>[0]> = {}) {
    const navigated: string[] = [];
    const connected: string[] = [];
    const base = {
      deviceId: 'dev-1',
      windowId: '@1',
      paneId: '%1',
      tmux: {
        connectedDevices: new Set<string>(),
        connectDevice: (deviceId: string) => connected.push(deviceId),
      },
      onPaneClick: (deviceId: string, windowId: string, paneId: string) =>
        navigated.push(`${deviceId}/${windowId}/${paneId}`),
      ...overrides,
    };
    return { base, navigated, connected };
  }

  test('宿主接了连接管理：未连接时先走适配器连接，再跳转', () => {
    const connectCalls: string[] = [];
    const { base, navigated } = deps({
      connection: {
        isConnected: () => false,
        connect: (deviceId: string) => connectCalls.push(deviceId),
      },
    });

    openStalePane(base);

    expect(connectCalls).toEqual(['dev-1']);
    expect(navigated).toEqual(['dev-1/@1/%1']);
  });

  test('已连接的设备不重复触发连接', () => {
    const connectCalls: string[] = [];
    const { base, navigated } = deps({
      connection: {
        isConnected: () => true,
        connect: (deviceId: string) => connectCalls.push(deviceId),
      },
    });

    openStalePane(base);

    expect(connectCalls).toEqual([]);
    expect(navigated).toEqual(['dev-1/@1/%1']);
  });

  test('宿主没接连接管理时兜底走 tmux store', () => {
    const { base, navigated, connected } = deps();

    openStalePane(base);

    expect(connected).toEqual(['dev-1']);
    expect(navigated).toEqual(['dev-1/@1/%1']);
  });

  test('tmux store 已订阅该设备时不重复订阅', () => {
    const { base, connected } = deps();
    base.tmux.connectedDevices = new Set(['dev-1']);

    openStalePane(base);

    expect(connected).toEqual([]);
  });
});
