// 顶栏纯图标按钮：每一枚都要有 aria-label 与说明气泡，且不再挂 title（否则原生提示叠一层）。
// bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML；气泡内容走 Portal，
// 关闭态不进静态 HTML，故这里断言的是触发器就位 + 标签文案。

import { describe, expect, test } from 'bun:test';
import type { TmuxPane, TmuxWindow } from '@vibeterm/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type ToolbarButtonsInput,
  ToolbarIconButton,
  ToolbarMoreMenu,
  buildToolbarButtons,
  buildToolbarMenuItems,
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

describe('顶栏「更多」菜单', () => {
  test('每个菜单项都有非空标签', () => {
    const labels = buildToolbarMenuItems(toolbarInput()).map((item) => item.label);
    expect(labels.length).toBe(4);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  test('触发器有 aria-label 与气泡，且不挂 title', () => {
    const html = renderToStaticMarkup(
      <ToolbarMoreMenu items={buildToolbarMenuItems(toolbarInput())} label="nav.more" />
    );
    expect(html).toContain('data-testid="console-more-button"');
    expect(html).toContain('aria-label="nav.more"');
    expect(html).toContain('data-slot="tooltip-trigger"');
    expect(html).not.toContain('title=');
  });

  // 菜单收起时这两个状态只剩触发器上的点，丢了等于界面上看不见「正在分享 / 规则已启用」
  test('分享中或有启用规则时触发器带指示点', () => {
    const idle = renderToStaticMarkup(
      <ToolbarMoreMenu items={buildToolbarMenuItems(toolbarInput())} label="nav.more" />
    );
    expect(idle).not.toContain('data-testid="console-more-indicator"');

    for (const overrides of [{ hasEnabledWatchRule: true }, { hasActiveShare: true }]) {
      const html = renderToStaticMarkup(
        <ToolbarMoreMenu items={buildToolbarMenuItems(toolbarInput(overrides))} label="nav.more" />
      );
      expect(html).toContain('data-testid="console-more-indicator"');
    }
  });
});
