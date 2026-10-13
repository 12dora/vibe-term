// 命令在当前状态下能不能执行：键盘钩子据此决定是否接管按键（不能执行的按键原样放行）。

import type { ExplorerMenuCommand } from './actions';

export interface ExplorerCommandState {
  selectedCount: number;
  /** 「打开」会作用到的那一项是不是目录 */
  primaryIsDirectory: boolean;
  canPaste: boolean;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  /** 本标签页里有被剪切的条目（Escape 可以取消） */
  hasCut: boolean;
  /** 目录列表已加载（新建文件夹的占位行要有视图可放） */
  listingReady: boolean;
}

type Predicate = (state: ExplorerCommandState) => boolean;

const hasSelection: Predicate = (state) => state.selectedCount > 0;
const singleSelection: Predicate = (state) => state.selectedCount === 1;

// 没列在这里的命令不依赖选择，总是可用
const COMMAND_RULES: Partial<Record<ExplorerMenuCommand, Predicate>> = {
  open: hasSelection,
  openInNewTab: (state) => hasSelection(state) && state.primaryIsDirectory,
  download: hasSelection,
  copy: hasSelection,
  cut: hasSelection,
  delete: hasSelection,
  rename: singleSelection,
  copyPath: singleSelection,
  paste: (state) => state.canPaste,
  back: (state) => state.canBack,
  forward: (state) => state.canForward,
  up: (state) => state.canUp,
  clearSelection: (state) => hasSelection(state) || state.hasCut,
  newFolder: (state) => state.listingReady,
};

export function isCommandAllowed(
  command: ExplorerMenuCommand,
  state: ExplorerCommandState
): boolean {
  return COMMAND_RULES[command]?.(state) ?? true;
}

// 自己会响应 Enter / 空格的可聚焦控件：原生的按钮、链接，以及带这些 ARIA 角色的自绘控件
// （Base UI 的复选框是 span[role="checkbox"]）。条目行是 role="option"，不在其列——
// 行上的 Enter 就是「打开」；只有不代表条目的 option（表头、占位行）才算控件。
const ACTIVATION_SELECTORS = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"][data-explorer-inert]',
  '[data-explorer-check]',
];

const ACTIVATION_SELECTOR = ACTIVATION_SELECTORS.join(', ');

/** 焦点在这类控件上时，Enter / 空格是「操作它」而不是文件管理器的命令。 */
export function isActivationTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== 'function') return false;
  return element.closest(ACTIVATION_SELECTOR) !== null;
}

const ACTIVATION_KEYS: ReadonlySet<string> = new Set(['Enter', ' ', 'Spacebar']);

export function isActivationKey(key: string): boolean {
  return ACTIVATION_KEYS.has(key);
}
