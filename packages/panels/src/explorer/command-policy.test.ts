import { describe, expect, test } from 'bun:test';
import type { ExplorerMenuCommand } from './actions/menu-model';
import {
  type ExplorerCommandState,
  isActivationKey,
  isActivationTarget,
  isCommandAllowed,
} from './command-policy';

function state(patch: Partial<ExplorerCommandState> = {}): ExplorerCommandState {
  return {
    selectedCount: 0,
    primaryIsDirectory: false,
    canPaste: false,
    canBack: false,
    canForward: false,
    canUp: false,
    hasCut: false,
    listingReady: true,
    ...patch,
  };
}

function allowed(commands: ExplorerMenuCommand[], current: ExplorerCommandState): boolean[] {
  return commands.map((command) => isCommandAllowed(command, current));
}

describe('isCommandAllowed', () => {
  test('没有选择时，需要选择的命令都不执行', () => {
    const commands: ExplorerMenuCommand[] = [
      'open',
      'openInNewTab',
      'download',
      'copy',
      'cut',
      'delete',
      'rename',
      'copyPath',
      'clearSelection',
    ];
    expect(allowed(commands, state())).toEqual(commands.map(() => false));
  });

  test('不依赖选择的命令始终可用', () => {
    const commands: ExplorerMenuCommand[] = [
      'selectAll',
      'focusFilter',
      'showShortcuts',
      'newTab',
      'closeTab',
      'split',
      'refresh',
      'newFolder',
      'upload',
      'uploadFolder',
    ];
    expect(allowed(commands, state())).toEqual(commands.map(() => true));
  });

  test('有选择即可打开 / 下载 / 复制 / 剪切 / 删除', () => {
    const current = state({ selectedCount: 3 });
    expect(allowed(['open', 'download', 'copy', 'cut', 'delete'], current)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test('重命名与复制路径只在恰好选中一项时可用', () => {
    expect(allowed(['rename', 'copyPath'], state({ selectedCount: 1 }))).toEqual([true, true]);
    expect(allowed(['rename', 'copyPath'], state({ selectedCount: 2 }))).toEqual([false, false]);
  });

  test('在新标签页中打开要求光标项是目录', () => {
    expect(isCommandAllowed('openInNewTab', state({ selectedCount: 1 }))).toBe(false);
    expect(
      isCommandAllowed('openInNewTab', state({ selectedCount: 2, primaryIsDirectory: true }))
    ).toBe(true);
  });

  test('粘贴只看剪贴板，与选择无关', () => {
    expect(isCommandAllowed('paste', state({ selectedCount: 2 }))).toBe(false);
    expect(isCommandAllowed('paste', state({ canPaste: true }))).toBe(true);
  });

  test('导航命令跟随各自的可用状态', () => {
    expect(allowed(['back', 'forward', 'up'], state())).toEqual([false, false, false]);
    expect(allowed(['back', 'forward', 'up'], state({ canBack: true, canUp: true }))).toEqual([
      true,
      false,
      true,
    ]);
  });

  test('Escape：有选择或有剪切态时才接管', () => {
    expect(isCommandAllowed('clearSelection', state({ selectedCount: 1 }))).toBe(true);
    expect(isCommandAllowed('clearSelection', state({ hasCut: true }))).toBe(true);
  });

  test('列表还没加载出来时不能新建文件夹', () => {
    expect(isCommandAllowed('newFolder', state({ listingReady: false }))).toBe(false);
  });
});

/** 只认 `closest`：自身（或祖先）命中选择器列表里的任意一项即返回非空 */
function element(...own: string[]): EventTarget {
  return {
    closest: (selector: string) =>
      selector.split(', ').some((item) => own.includes(item)) ? {} : null,
  } as unknown as EventTarget;
}

describe('isActivationTarget', () => {
  test('原生按钮、链接与自绘控件都算', () => {
    for (const selector of [
      'button',
      'a[href]',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="option"][data-explorer-inert]',
      '[data-explorer-check]',
    ]) {
      expect(isActivationTarget(element(selector))).toBe(true);
    }
  });

  test('条目行（role="option"）不算：行上的 Enter 是「打开」', () => {
    expect(isActivationTarget(element('[role="option"]'))).toBe(false);
    expect(isActivationTarget(element('[role="listbox"]'))).toBe(false);
  });

  test('空目标与没有 closest 的目标不算', () => {
    expect(isActivationTarget(null)).toBe(false);
    expect(isActivationTarget({} as EventTarget)).toBe(false);
  });
});

describe('isActivationKey', () => {
  test('Enter 与空格是控件的激活键，其余不是', () => {
    expect(isActivationKey('Enter')).toBe(true);
    expect(isActivationKey(' ')).toBe(true);
    expect(isActivationKey('Escape')).toBe(false);
    expect(isActivationKey('a')).toBe(false);
  });
});
