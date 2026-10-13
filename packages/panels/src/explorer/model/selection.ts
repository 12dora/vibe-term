// 有序路径列表上的纯选择模型：anchor 是 shift 区间的起点，focus 是键盘光标。

export interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
}

export const EMPTY_SELECTION: SelectionState = {
  selected: new Set<string>(),
  anchor: null,
  focus: null,
};

export function selectOnly(path: string): SelectionState {
  return { selected: new Set([path]), anchor: path, focus: path };
}

export function toggleOne(state: SelectionState, path: string): SelectionState {
  const selected = new Set(state.selected);
  if (!selected.delete(path)) selected.add(path);
  return { selected, anchor: path, focus: path };
}

// 区间起点：anchor 优先，其次 focus；两者都不在列表里时退到第一项。
function rangeOrigin(state: SelectionState, order: readonly string[]): number {
  for (const candidate of [state.anchor, state.focus]) {
    if (candidate === null) continue;
    const index = order.indexOf(candidate);
    if (index >= 0) return index;
  }
  return 0;
}

export function selectRange(
  state: SelectionState,
  order: readonly string[],
  path: string,
  additive = false
): SelectionState {
  const target = order.indexOf(path);
  if (target < 0) return state;
  const origin = rangeOrigin(state, order);
  const range = order.slice(Math.min(origin, target), Math.max(origin, target) + 1);
  const selected = additive ? new Set([...state.selected, ...range]) : new Set(range);
  return { selected, anchor: order[origin] ?? path, focus: path };
}

export function selectAll(order: readonly string[]): SelectionState {
  if (order.length === 0) return EMPTY_SELECTION;
  return { selected: new Set(order), anchor: order[0], focus: order[0] };
}

function focusTarget(current: number, delta: number, count: number): number {
  if (delta === Number.NEGATIVE_INFINITY) return 0;
  if (delta === Number.POSITIVE_INFINITY) return count - 1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return Math.min(count - 1, Math.max(0, current + delta));
}

export function moveFocus(
  state: SelectionState,
  order: readonly string[],
  delta: number,
  opts: { extend: boolean }
): SelectionState {
  if (order.length === 0) return EMPTY_SELECTION;
  const cursor = state.focus ?? state.anchor;
  const current = cursor === null ? -1 : order.indexOf(cursor);
  const target = order[focusTarget(current, delta, order.length)];
  // 没有光标时无从扩展，落点即新的起点
  if (!opts.extend || current < 0) return selectOnly(target);
  return selectRange(state, order, target, false);
}

/** 列表刷新后摘掉已消失的路径；没有变化时返回原引用。 */
export function pruneSelection(state: SelectionState, order: readonly string[]): SelectionState {
  const alive = new Set(order);
  const selected = new Set([...state.selected].filter((path) => alive.has(path)));
  const anchor = state.anchor !== null && alive.has(state.anchor) ? state.anchor : null;
  const focus = state.focus !== null && alive.has(state.focus) ? state.focus : null;
  const unchanged =
    selected.size === state.selected.size && anchor === state.anchor && focus === state.focus;
  return unchanged ? state : { selected, anchor, focus };
}

export function selectByRect(
  order: readonly string[],
  hit: ReadonlySet<string>,
  base: SelectionState,
  additive: boolean
): SelectionState {
  const selected = additive ? new Set([...base.selected, ...hit]) : new Set(hit);
  let last: string | null = null;
  for (const path of order) {
    if (hit.has(path)) last = path;
  }
  if (last === null) return { selected, anchor: base.anchor, focus: base.focus };
  return { selected, anchor: last, focus: last };
}
