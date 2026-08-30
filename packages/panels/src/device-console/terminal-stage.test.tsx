// 终端显示区的分支：快照确认 pane 已关闭时既不挂 Terminal 也不显示「连接中」遮罩。
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
import { TerminalStage } from './terminal-stage';
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
              resolvedPaneId="%1"
              selectedWindow={window1}
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
});
