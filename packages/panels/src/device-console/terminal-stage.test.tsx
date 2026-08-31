// 终端显示区的分支：快照确认 pane 已关闭时既不挂 Terminal 也不显示「连接中」遮罩，
// 以及单屏保活池的可见/隐藏结构。
// bun test 无 DOM，用 react-dom/server 静态渲染断言首帧结构（与 device-row.test.tsx 同一套做法）。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18N_RESOURCES, type TmuxPane, type TmuxWindow } from '@tmex/shared';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { resolveTerminalTheme } from '@tmex/theme';
import i18next from 'i18next';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { KeepAlivePaneSlot, TerminalStage } from './terminal-stage';
import type { DevicePaneSelection } from './use-device-pane-selection';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24 };
}

const window1: TmuxWindow = {
  id: '@1',
  name: 'shell',
  index: 0,
  active: true,
  panes: [pane('%1')],
};

const splitWindow: TmuxWindow = {
  id: '@1',
  name: 'shell',
  index: 0,
  active: true,
  layout: 'abcd,80x24,0,0[80x12,0,0,1,80x11,0,13,2]',
  panes: [pane('%1'), pane('%2')],
};

function selection(overrides: Partial<DevicePaneSelection> = {}): DevicePaneSelection {
  return {
    isWindowMissing: false,
    isPaneMissing: false,
    isSelectionInvalid: false,
    isPaneConfirmedClosed: false,
    isSplitView: false,
    canInteractWithPane: true,
    handleResize: () => {},
    handleSync: () => {},
    handleResizeSettled: () => {},
    handleUserSelectPane: () => {},
    handleClosePane: () => {},
    ...overrides,
  };
}

let storageSeq = 0;

function renderStage(options: {
  selectedPane?: TmuxPane;
  selection: DevicePaneSelection;
  resolvedPaneId?: string;
  selectedWindow?: TmuxWindow;
}): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `terminal-stage-test-${storageSeq++}:`,
  });
  return renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <TerminalStage
              deviceId="dev-1"
              windowId="@1"
              resolvedPaneId={options.resolvedPaneId ?? '%1'}
              selectedWindow={options.selectedWindow ?? window1}
              selectedPane={options.selectedPane}
              selection={options.selection}
              deviceConnected
              isReconnecting={false}
              isIntentionallyDisconnected={false}
              isMobile={false}
              inputMode="direct"
              terminalTheme={resolveTerminalTheme('dark', null)}
              terminalContainerRef={createRef<HTMLDivElement>()}
              terminalRef={createRef()}
              bindFocusedTerminalRef={() => {}}
              prepareResources={() => Promise.resolve()}
              onActivateShortcut={() => {}}
            />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
}

describe('TerminalStage', () => {
  test('shows the resolving overlay while the snapshot has not produced the routed pane yet', () => {
    const html = renderStage({ selectedPane: undefined, selection: selection() });
    expect(html).toContain('terminal-status-overlay');
    expect(html).toContain('data-terminal-engine');
  });

  test('mounts no terminal and no overlay once the snapshot confirms the pane was closed', () => {
    const html = renderStage({
      selectedPane: undefined,
      selection: selection({ isPaneMissing: true, isPaneConfirmedClosed: true }),
    });
    expect(html).not.toContain('terminal-status-overlay');
    expect(html).not.toContain('data-terminal-engine');
  });

  test('keeps the closed-selection notice for targets that never showed up', () => {
    const html = renderStage({
      selectedPane: undefined,
      selection: selection({ isPaneMissing: true, isSelectionInvalid: true }),
    });
    expect(html).toContain('terminal-selection-invalid');
  });

  test('mounts a single keep-alive slot for the first pane of a device', () => {
    const html = renderStage({ selectedPane: pane('%1'), selection: selection() });
    expect(html.match(/data-testid="terminal-keep-alive-pane"/g)).toHaveLength(1);
    expect(html).toContain('data-pane-id="%1"');
    expect(html).toContain('data-visible="true"');
    expect(html).not.toContain('opacity:0');
  });

  test('the split view renders no keep-alive slots', () => {
    const html = renderStage({
      selectedPane: pane('%1'),
      selection: selection({ isSplitView: true }),
      selectedWindow: splitWindow,
    });
    expect(html).toContain('split-terminal-area');
    expect(html).not.toContain('terminal-keep-alive-pane');
  });
});

// 池归组件实例所有，SSR 只渲染一帧拿不到多 pane 的树；槽位本身单独断言，
// 多 pane 的池演进由 terminal-keep-alive.test.ts 覆盖。
describe('KeepAlivePaneSlot', () => {
  test('the visible slot is interactive and exposed to accessibility', () => {
    const html = renderToStaticMarkup(
      <KeepAlivePaneSlot paneId="%1" visible>
        <span>pane</span>
      </KeepAlivePaneSlot>
    );
    expect(html).toContain('data-pane-id="%1"');
    expect(html).toContain('data-visible="true"');
    expect(html).not.toContain('opacity:0');
    // 可见槽恒在最上层：后代（ghostty mount）会显式写 visibility/pointer-events，
    // 祖先用 visibility/pointer-events 藏不住，只能靠 opacity + z-index
    expect(html).toContain('z-index:1');
    expect(html).not.toContain('aria-hidden');
  });

  test('the hidden slot keeps its layout box but is inert', () => {
    const html = renderToStaticMarkup(
      <KeepAlivePaneSlot paneId="%2" visible={false}>
        <span>pane</span>
      </KeepAlivePaneSlot>
    );
    // absolute inset-0：与可见槽同一个盒子，隐藏实例的 cols/rows 才不会漂移
    expect(html).toContain('absolute inset-0');
    expect(html).toContain('aria-hidden="true"');
    // 不能用 visibility:hidden——ghostty mount 在 activateRenderTarget() 里显式
    // 写 visibility:visible，后代会反选祖先的 hidden（1.1.4 线上「切 tab 终端不刷新」根因）
    expect(html).not.toContain('visibility:hidden');
    expect(html).toContain('opacity:0');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('z-index:0');
    expect(html).not.toContain('data-visible');
  });
});
