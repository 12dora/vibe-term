// 设备行的展开/收起外壳：子树改由受控 Collapsible 承载（收起播完退场再卸载）。
// bun test 无 DOM，用 react-dom/server 静态渲染断言结构（与 device-card.test.tsx 同一套做法）。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { I18N_RESOURCES } from '@tmex/shared';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
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

function renderRow(options: { isExpanded: boolean; isSelected?: boolean }): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `device-row-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <SortableVerticalList ids={[DEVICE.id]} onReorder={() => undefined}>
              <DeviceRow
                device={DEVICE}
                isExpanded={options.isExpanded}
                isSelected={options.isSelected ?? false}
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

/** 选中指示条那一段开标签（它没有 testid，只能按专属背景色找） */
function indicatorTag(html: string): string {
  const index = html.indexOf('bg-muted-foreground/70');
  expect(index).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', index), html.indexOf('>', index) + 1);
}

describe('DeviceRow 子树的展开态', () => {
  test('展开时子树挂在 collapsible 面板里，缩进与 testid 不变', () => {
    const html = renderRow({ isExpanded: true });

    expect(html).toContain('data-slot="collapsible-content"');
    expect(html).toContain(`data-testid="device-tree-${DEVICE.id}"`);
    // e2e 断言子树左内边距 >= 20px；缩进留在子树自身而不是动画面板上
    expect(html).toContain('pl-6');
  });

  test('收起时面板整块不渲染（Base UI 默认 keepMounted=false），设备行本身还在', () => {
    const html = renderRow({ isExpanded: false });

    expect(html).toContain(`data-testid="device-item-${DEVICE.id}"`);
    expect(html).not.toContain(`data-testid="device-tree-${DEVICE.id}"`);
    expect(html).not.toContain('data-slot="collapsible-content"');
  });

  test('子树不再叠一层入场动画：tmex-reveal 由 collapsible 的高度过渡取代', () => {
    expect(renderRow({ isExpanded: true })).not.toContain('tmex-reveal');
  });

  test('选中指示条常驻，只切透明度，未选中时也在 DOM 里', () => {
    const selected = indicatorTag(renderRow({ isExpanded: false, isSelected: true }));
    const idle = indicatorTag(renderRow({ isExpanded: false, isSelected: false }));

    expect(selected).toContain('opacity-100');
    expect(selected).toContain('transition-opacity');
    expect(idle).toContain('opacity-0');
    expect(idle).toContain('transition-opacity');
  });
});
