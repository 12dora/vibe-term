// 分栏占比的纯计算：拖动第 index 条分隔线只在它左右两栏之间挪动空间，其余分栏不变。

/** 键盘每按一次方向键挪动的占比 */
export const PANE_KEYBOARD_STEP = 0.02;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 把第 index 条分隔线向右挪 `deltaFraction`（负数向左）。
 * 两侧分栏都不会小于 `min`；两栏合计已经放不下两个下限时原样返回。
 */
export function resizePanes(
  sizes: readonly number[],
  index: number,
  deltaFraction: number,
  min: number
): number[] {
  const left = sizes[index];
  const right = sizes[index + 1];
  if (left === undefined || right === undefined || !Number.isFinite(deltaFraction)) {
    return [...sizes];
  }
  const total = left + right;
  if (total < min * 2) return [...sizes];
  const nextLeft = clamp(left + deltaFraction, min, total - min);
  const next = [...sizes];
  next[index] = nextLeft;
  next[index + 1] = total - nextLeft;
  return next;
}

export function equalPaneSizes(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, () => 1 / count);
}

/** 拖动预览只在分栏数没变时有效（拖动途中分栏被关掉就作废） */
export function effectivePaneSizes(
  preview: readonly number[] | null,
  stored: readonly number[],
  count: number
): number[] {
  if (preview && preview.length === count) return [...preview];
  if (stored.length === count) return [...stored];
  return equalPaneSizes(count);
}
