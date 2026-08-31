export const SELECTION_TOOLBAR_SELECTOR = '[data-testid="terminal-selection-toolbar"]';

export interface SelectionDismissIntent {
  hasSelection: boolean;
  pointerType: string;
  button: number;
  target: unknown;
}

function hitsToolbar(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return false;
  return Boolean(
    (closest as (selector: string) => unknown).call(target, SELECTION_TOOLBAR_SELECTOR)
  );
}

// 选区工具条浮在终端顶部中央，遮住约 3 行画布。有选区时在画布上按下左键，先于 ghostty 的
// mousedown 收起工具条并清掉旧选区，同一次手势即可在原本被遮住的位置开新选区。
// 触摸交给 useMobileTouch 的手势机：那里的选区/软键盘时序自成一套，指针层不得插手。
export function shouldDismissSelectionOnPointerDown(intent: SelectionDismissIntent): boolean {
  if (!intent.hasSelection) return false;
  if (intent.pointerType === 'touch') return false;
  if (intent.button !== 0) return false;
  return !hitsToolbar(intent.target);
}
