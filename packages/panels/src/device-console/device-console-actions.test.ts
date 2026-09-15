import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StateSnapshotPayload, TmuxPane, TmuxWindow, WatchRuleDto } from '@vibeterm/shared';

import {
  type ToolbarButton,
  type ToolbarButtonsInput,
  buildToolbarButtons,
  buildToolbarMenuItems,
  hasToolbarMenuIndicator,
} from './device-console-toolbar';
import {
  type DeviceConsoleActionsModel,
  findPane,
  findWindow,
  hasEnabledWatchRule,
  nextInputMode,
  panePath,
} from './use-device-console-actions';

const t = (key: string) => key;

function pane(id: string): TmuxPane {
  return { id, windowId: '@1', index: 0, active: true, width: 80, height: 24 };
}

function tmuxWindow(panes: TmuxPane[]): TmuxWindow {
  return { id: '@1', name: 'one', index: 0, active: true, panes };
}

function snapshot(windows: TmuxWindow[]): StateSnapshotPayload {
  return { session: { windows } } as unknown as StateSnapshotPayload;
}

function rule(enabled: boolean): WatchRuleDto {
  return { id: 'r1', enabled } as WatchRuleDto;
}

function model(overrides: Partial<DeviceConsoleActionsModel> = {}): DeviceConsoleActionsModel {
  return {
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
  };
}

function toolbarInput(overrides: Partial<DeviceConsoleActionsModel> = {}): ToolbarButtonsInput {
  return {
    model: model(overrides),
    t,
    onOpenRefreshConfirm: () => {},
    onOpenWatchDialog: () => {},
    onOpenTerminalSettings: () => {},
    onOpenShareDialog: () => {},
  };
}

const testIdsOf = (buttons: ToolbarButton[]) => buttons.map((button) => button.testId);
const findButton = (buttons: ToolbarButton[], key: string) =>
  buttons.find((button) => button.key === key);

describe('selection helpers', () => {
  test('finds the window named by the route', () => {
    expect(findWindow(snapshot([tmuxWindow([pane('%1')])]), '@1')?.id).toBe('@1');
    expect(findWindow(snapshot([tmuxWindow([pane('%1')])]), '@9')).toBeUndefined();
    expect(findWindow(undefined, '@1')).toBeUndefined();
    expect(findWindow(snapshot([tmuxWindow([pane('%1')])]), undefined)).toBeUndefined();
  });

  test('finds the pane inside the selected window', () => {
    const target = tmuxWindow([pane('%1'), pane('%2')]);
    expect(findPane(target, '%2')?.id).toBe('%2');
    expect(findPane(target, '%9')).toBeUndefined();
    expect(findPane(undefined, '%1')).toBeUndefined();
    expect(findPane(target, undefined)).toBeUndefined();
  });

  test('reports an enabled watch rule only when one exists', () => {
    expect(hasEnabledWatchRule(undefined)).toBe(false);
    expect(hasEnabledWatchRule([])).toBe(false);
    expect(hasEnabledWatchRule([rule(false)])).toBe(false);
    expect(hasEnabledWatchRule([rule(false), rule(true)])).toBe(true);
  });

  test('encodes the pane id into the route path', () => {
    expect(panePath('d1', '@1', '%1')).toBe('/devices/d1/windows/@1/panes/%251');
  });

  test('toggles the input mode', () => {
    expect(nextInputMode('direct')).toBe('editor');
    expect(nextInputMode('editor')).toBe('direct');
  });
});

describe('buildToolbarButtons', () => {
  test('keeps the desktop icon buttons and test ids', () => {
    expect(testIdsOf(buildToolbarButtons(toolbarInput()))).toEqual([
      'split-right-button',
      'split-down-button',
      'keyboard-behavior-open-button',
    ]);
  });

  test('drops the split buttons on mobile viewports', () => {
    const buttons = buildToolbarButtons(toolbarInput({ isMobileViewport: true }));
    expect(findButton(buttons, 'split-right')).toBeUndefined();
    expect(findButton(buttons, 'split-down')).toBeUndefined();
    expect(findButton(buttons, 'terminal-settings')?.testId).toBe('keyboard-behavior-open-button');
  });

  test('disables split while the pane is not interactive, but keeps terminal settings usable', () => {
    const buttons = buildToolbarButtons(toolbarInput({ canInteract: false }));
    expect(findButton(buttons, 'split-right')?.disabled).toBe(true);
    expect(findButton(buttons, 'terminal-settings')?.disabled).toBeUndefined();
  });

  // 被分享人不能改分屏结构，服务端也会拒掉 SPLIT_PANE：入口不该还留着
  test('drops the split buttons when structural actions are off', () => {
    const buttons = buildToolbarButtons(toolbarInput({ structureUi: false }));
    expect(findButton(buttons, 'split-right')).toBeUndefined();
    expect(findButton(buttons, 'split-down')).toBeUndefined();
    expect(findButton(buttons, 'terminal-settings')).toBeDefined();
  });

  test('routes each button to its handler', () => {
    const calls: string[] = [];
    const input: ToolbarButtonsInput = {
      ...toolbarInput(),
      model: model({ onSplitPane: (direction) => calls.push(`split:${direction}`) }),
      onOpenTerminalSettings: () => calls.push('terminal-settings'),
    };

    for (const button of buildToolbarButtons(input)) button.onClick();

    expect(calls).toEqual(['split:right', 'split:down', 'terminal-settings']);
  });
});

describe('buildToolbarMenuItems', () => {
  test('keeps the menu order and test ids', () => {
    expect(testIdsOf(buildToolbarMenuItems(toolbarInput()))).toEqual([
      'refresh-page-button',
      'terminal-input-mode-toggle',
      'share-open-button',
      'watch-open-button',
    ]);
  });

  test('keeps the same menu on mobile viewports', () => {
    expect(testIdsOf(buildToolbarMenuItems(toolbarInput({ isMobileViewport: true })))).toEqual(
      testIdsOf(buildToolbarMenuItems(toolbarInput()))
    );
  });

  test('drops the watch item when the featureset disables watch UI', () => {
    expect(
      findButton(buildToolbarMenuItems(toolbarInput({ watchUi: false })), 'watch')
    ).toBeUndefined();
  });

  test('drops the share item when the runtime is a share viewer', () => {
    expect(
      findButton(buildToolbarMenuItems(toolbarInput({ shareUi: false })), 'share')
    ).toBeUndefined();
  });

  // 被分享人没有分屏入口，但刷新与输入模式照旧
  test('keeps refresh and input mode when structural actions are off', () => {
    const items = buildToolbarMenuItems(toolbarInput({ structureUi: false }));
    expect(findButton(items, 'refresh')).toBeDefined();
    expect(findButton(items, 'input-mode')).toBeDefined();
  });

  test('disables the input mode item while the pane is not interactive, but keeps refresh usable', () => {
    const items = buildToolbarMenuItems(toolbarInput({ canInteract: false }));
    expect(findButton(items, 'input-mode')?.disabled).toBe(true);
    expect(findButton(items, 'refresh')?.disabled).toBeUndefined();
  });

  test('disables watch without a resolved pane', () => {
    const items = buildToolbarMenuItems(toolbarInput({ resolvedPaneId: undefined }));
    expect(findButton(items, 'watch')?.disabled).toBe(true);
  });

  test('shows the watch badge only while a rule is enabled', () => {
    expect(findButton(buildToolbarMenuItems(toolbarInput()), 'watch')?.badge).toEqual({
      testId: 'watch-active-indicator',
      visible: false,
    });
    expect(
      findButton(buildToolbarMenuItems(toolbarInput({ hasEnabledWatchRule: true })), 'watch')?.badge
        ?.visible
    ).toBe(true);
  });

  test('disables share without a device or window', () => {
    expect(
      findButton(buildToolbarMenuItems(toolbarInput({ windowId: undefined })), 'share')?.disabled
    ).toBe(true);
    expect(
      findButton(buildToolbarMenuItems(toolbarInput({ deviceId: undefined })), 'share')?.disabled
    ).toBe(true);
    expect(findButton(buildToolbarMenuItems(toolbarInput()), 'share')?.disabled).toBe(false);
  });

  test('highlights share and shows the viewer count only while a share is active', () => {
    const idle = findButton(buildToolbarMenuItems(toolbarInput()), 'share');
    expect(idle?.active).toBe(false);
    expect(idle?.badge?.visible).toBe(false);
    expect(idle?.label).toBe('share.toolbar.share');

    const active = findButton(
      buildToolbarMenuItems(toolbarInput({ hasActiveShare: true, shareViewers: 3 })),
      'share'
    );
    expect(active?.active).toBe(true);
    expect(active?.badge).toEqual({
      testId: 'share-active-indicator',
      visible: true,
      count: 3,
    });
    expect(active?.label).toBe('share.toolbar.active');
  });

  test('labels the input-mode item by the target mode', () => {
    expect(findButton(buildToolbarMenuItems(toolbarInput()), 'input-mode')?.label).toBe(
      'nav.switchToEditor'
    );
    expect(
      findButton(buildToolbarMenuItems(toolbarInput({ inputMode: 'editor' })), 'input-mode')?.label
    ).toBe('nav.switchToDirect');
  });

  test('routes each menu item to its handler', () => {
    const calls: string[] = [];
    const input: ToolbarButtonsInput = {
      ...toolbarInput(),
      model: model({ onToggleInputMode: () => calls.push('input-mode') }),
      onOpenRefreshConfirm: () => calls.push('refresh'),
      onOpenWatchDialog: () => calls.push('watch'),
      onOpenShareDialog: () => calls.push('share'),
    };

    for (const item of buildToolbarMenuItems(input)) item.onClick();

    expect(calls).toEqual(['refresh', 'input-mode', 'share', 'watch']);
  });
});

// 菜单收起时，分享中 / 有启用规则要在 ⋯ 触发器上留一个点，否则这两个状态从界面上消失
describe('hasToolbarMenuIndicator', () => {
  test('is on only while a menu badge is showing', () => {
    expect(hasToolbarMenuIndicator(buildToolbarMenuItems(toolbarInput()))).toBe(false);
    expect(
      hasToolbarMenuIndicator(buildToolbarMenuItems(toolbarInput({ hasEnabledWatchRule: true })))
    ).toBe(true);
    expect(
      hasToolbarMenuIndicator(
        buildToolbarMenuItems(toolbarInput({ hasActiveShare: true, shareViewers: 2 }))
      )
    ).toBe(true);
    expect(
      hasToolbarMenuIndicator(
        buildToolbarMenuItems(toolbarInput({ hasEnabledWatchRule: true, watchUi: false }))
      )
    ).toBe(false);
  });
});

const localesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../shared/src/i18n/locales'
);

async function translationOf(locale: string): Promise<Record<string, unknown>> {
  const json = (await Bun.file(path.join(localesDir, `${locale}.json`)).json()) as {
    translation: Record<string, unknown>;
  };
  return json.translation;
}

function lookup(translation: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, translation);
}

// 兜底条的视图模型在 deferred-terminal-settings-sheet.test.tsx 覆盖，这里只守 i18n key 落地
describe('terminal settings fallback i18n keys', () => {
  test('every fallback key is translated in all locales', async () => {
    const keys = [
      'settings.terminal.loading',
      'settings.terminal.loadFailed',
      'settings.terminal.loadFailedHint',
      'settings.terminal.reloadApp',
      'common.retry',
      'common.close',
    ];
    for (const locale of ['en_US', 'zh_CN', 'ja_JP']) {
      const translation = await translationOf(locale);
      for (const key of keys) {
        expect(typeof lookup(translation, key)).toBe('string');
      }
    }
  });
});
