// 行菜单项数组按输入 memo：输入不变时重渲染必须拿到同一个引用（metadata patch 放大后每行每帧一次）。
// bun test 无 DOM：用「渲染期 setState 触发同一实例再渲染」的方式在 react-dom/server 里做重渲染。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18N_RESOURCES } from '@tmex/shared';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import i18next from 'i18next';
import { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';

import type { DeviceTreeNavigation } from './agent-adapter';
import type { DeviceActionItem } from './device-actions-menu';
import { usePaneActionItems, useWindowActionItems } from './use-row-action-items';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const PANE: TmuxPane = {
  id: '%1',
  windowId: '@1',
  index: 0,
  active: true,
  width: 80,
  height: 24,
  title: 'zsh',
  currentPath: '/home/k',
  currentCommand: 'zsh',
};

const WINDOW: TmuxWindow = {
  id: '@1',
  index: 0,
  name: 'main',
  active: true,
  panes: [PANE],
};

const NAV: DeviceTreeNavigation = {
  navigateToPane: () => undefined,
};

let seq = 0;

/** 渲染一次组件但让它在同一实例上渲染两遍，返回两遍拿到的数组 */
function renderTwice(useItems: () => DeviceActionItem[]): [DeviceActionItem[], DeviceActionItem[]] {
  const seen: DeviceActionItem[][] = [];
  function Probe() {
    const [pass, setPass] = useState(0);
    seen.push(useItems());
    if (pass === 0) setPass(1);
    return null;
  }
  const runtime = createAppRuntime({ nodeId: 'self', storagePrefix: `row-actions-${seq++}:` });
  renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <Probe />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  expect(seen).toHaveLength(2);
  return [seen[0] as DeviceActionItem[], seen[1] as DeviceActionItem[]];
}

const noop = () => undefined;

describe('useWindowActionItems', () => {
  test('输入不变时重渲染拿到同一个数组引用', () => {
    const [first, second] = renderTwice(() =>
      useWindowActionItems({
        deviceId: 'dev-1',
        tmuxWindow: WINDOW,
        isDeviceSelected: true,
        selectedPaneId: PANE.id,
        onPaneClick: noop,
        onWindowClick: noop,
        onCloseWindow: noop,
        onClosePane: noop,
        onRenameWindow: noop,
        onRenamePane: noop,
        onWatchPane: noop,
        nav: NAV,
      })
    );
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});

describe('usePaneActionItems', () => {
  test('输入不变时重渲染拿到同一个数组引用', () => {
    const [first, second] = renderTwice(() =>
      usePaneActionItems({
        deviceId: 'dev-1',
        windowId: WINDOW.id,
        pane: PANE,
        isActive: true,
        isMobile: false,
        onPaneClick: noop,
        onClosePane: noop,
        onRenamePane: noop,
        onWatchPane: noop,
        nav: NAV,
      })
    );
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});
