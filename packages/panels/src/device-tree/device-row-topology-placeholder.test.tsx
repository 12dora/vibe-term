// 冷启动占位在设备行上的接线：tmux store 从本地缓存 hydrate 出的拓扑先撑起「标签页」。
// 「实时快照到货即换成实时树」由 device-tree-selectors.test.ts 的选择器用例覆盖
//（react-dom/server 下 zustand 读的是 getInitialState，建店后改 state 影响不到静态渲染）。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Device } from '@vibeterm/shared';
import { I18N_RESOURCES } from '@vibeterm/shared';
import { createAppRuntime } from '@vibeterm/stores';
import { RuntimeProvider } from '@vibeterm/stores/react';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import { writeTmuxTopology } from '@vibeterm/stores/tmux-topology-cache';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { DeviceRow } from './device-row';
import { SortableVerticalList } from './device-tree-dnd';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const DEVICE: Device = {
  id: 'dev-1',
  name: '书房',
  type: 'local',
  authMode: 'auto',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let storageSeq = 0;

function renderExpandedRow(): string {
  const storagePrefix = `device-row-topology-${storageSeq++}:`;
  writeTmuxTopology(storagePrefix, DEVICE.id, {
    savedAt: Date.now(),
    windows: [
      {
        id: '@cached',
        index: 0,
        name: 'zsh',
        active: true,
        customName: '上次的窗口',
        panes: [{ id: '%cached', index: 0, active: true }],
      },
    ],
  });

  const runtime = createAppRuntime({ nodeId: 'self', storagePrefix });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <SortableVerticalList ids={[DEVICE.id]} onReorder={() => undefined}>
              <DeviceRow
                device={DEVICE}
                isExpanded
                isSelected={false}
                onExpandedChange={() => undefined}
                onCreateWindow={() => undefined}
                onCloseWindow={() => undefined}
                onClosePane={() => undefined}
                onRenameWindow={() => undefined}
                onRenamePane={() => undefined}
                onPaneClick={() => undefined}
                onWindowClick={() => undefined}
                onWatchPane={() => undefined}
                nav={{ navigateToPane: () => undefined }}
              />
            </SortableVerticalList>
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('设备行的冷启动占位', () => {
  test('无实时快照时渲染缓存拓扑，而不是「加载中」', () => {
    const html = renderExpandedRow();

    expect(html).toContain(`data-testid="stale-topology-${DEVICE.id}"`);
    expect(html).toContain('data-testid="stale-window-item-@cached"');
    expect(html).toContain('上次的窗口');
    expect(html).not.toContain(i18n.t('common.loading'));
  });

  test('缓存里没有这台设备时仍是加载态', () => {
    const runtime = createAppRuntime({
      nodeId: 'self',
      storagePrefix: `device-row-topology-empty-${storageSeq++}:`,
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={new QueryClient()}>
            <RuntimeProvider runtime={runtime}>
              <SortableVerticalList ids={[DEVICE.id]} onReorder={() => undefined}>
                <DeviceRow
                  device={DEVICE}
                  isExpanded
                  isSelected={false}
                  onExpandedChange={() => undefined}
                  onCreateWindow={() => undefined}
                  onCloseWindow={() => undefined}
                  onClosePane={() => undefined}
                  onRenameWindow={() => undefined}
                  onRenamePane={() => undefined}
                  onPaneClick={() => undefined}
                  onWindowClick={() => undefined}
                  onWatchPane={() => undefined}
                  nav={{ navigateToPane: () => undefined }}
                />
              </SortableVerticalList>
            </RuntimeProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </MemoryRouter>
    );
    runtime.dispose();

    expect(html).toContain(i18n.t('common.loading'));
    expect(html).not.toContain('stale-topology-');
  });
});
