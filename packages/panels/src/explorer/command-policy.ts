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

const ACTIVATION_SELECTOR =
  'button, a[href], summary, [role="button"], [role="menuitem"], [role="switch"], [role="tab"]';

/** 焦点在按钮这类控件上时，Enter 是「按下它」而不是「打开选中项」。 */
export function isActivationTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (!element || typeof element.closest !== 'function') return false;
  return element.closest(ACTIVATION_SELECTOR) !== null;
}
