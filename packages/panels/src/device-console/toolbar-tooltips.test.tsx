// 顶栏纯图标按钮：每一枚都要有 aria-label 与说明气泡，且不再挂 title（否则原生提示叠一层）。
// bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML；气泡内容走 Portal，
// 关闭态不进静态 HTML，故这里断言的是触发器就位 + 标签文案。

import { describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxWindow } from '@tmex/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type ToolbarButtonsInput,
  ToolbarIconButton,
  buildToolbarButtons,
} from './device-console-toolbar';
import type { DeviceConsoleActionsModel } from './use-device-console-actions';

const t = (key: string) => key;

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24 };
}

function tmuxWindow(panes: TmuxPane[]): TmuxWindow {
  return { id: '@1', name: 'one', index: 0, active: true, panes };
}

function toolbarInput(overrides: Partial<DeviceConsoleActionsModel> = {}): ToolbarButtonsInput {
  return {
    model: {
      deviceId: 'd1',
      windowId: '@1',
      resolvedPaneId: '%1',
      selectedWindow: tmuxWindow([pane('%1')]),
      isMobileViewport: false,
      inputMode: 'direct',
      canInteract: true,
      watchUi: true,
      hasEnabledWatchRule: false,
      shareUi: true,
      structureUi: true,
      hasActiveShare: false,
      shareViewers: 0,
      onSwitchPane: () => {},
      onSplitPane: () => {},
      onToggleInputMode: () => {},
      onConfirmRefresh: () => {},
      ...overrides,
    },
    t,
    onOpenRefreshConfirm: () => {},
    onOpenWatchDialog: () => {},
    onOpenTerminalSettings: () => {},
    onOpenShareDialog: () => {},
  };
}

describe('顶栏图标按钮的说明气泡', () => {
  test('每一枚按钮都有非空标题', () => {
    const labels = buildToolbarButtons(toolbarInput()).map((button) => button.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  test('渲染出 aria-label 与气泡触发器，且不再挂 title', () => {
    for (const button of buildToolbarButtons(toolbarInput())) {
      const html = renderToStaticMarkup(<ToolbarIconButton button={button} />);
      expect(html).toContain(`aria-label="${button.label}"`);
      expect(html).toContain('data-slot="tooltip-trigger"');
      expect(html).not.toContain('title=');
    }
  });

  test('禁用态按钮同样带标题：气泡挂在外层 span 上，禁用的 button 不吞指针事件', () => {
    const disabled = buildToolbarButtons(toolbarInput({ canInteract: false })).filter(
      (button) => button.disabled
    );
    expect(disabled.length).toBeGreaterThan(0);
    for (const button of disabled) {
      const html = renderToStaticMarkup(<ToolbarIconButton button={button} />);
      expect(html).toContain('data-slot="tooltip-trigger"');
      expect(html).toContain(`aria-label="${button.label}"`);
      expect(html).toContain('disabled=""');
    }
  });
});
