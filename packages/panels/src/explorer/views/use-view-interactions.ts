// 两种视图共用的指针 + 键盘交互：全部挂在容器上，按 `data-explorer-path` 找回命中的行。
// 命令类快捷键（Enter / Delete / F2 / mod+A…）不在这里处理，也不拦截冒泡。

import type { FileEntryDto } from '@vibeterm/shared';
import type { KeyboardEvent, MouseEvent, RefObject } from 'react';
import { useMemo, useRef } from 'react';
import { typeAheadMatch } from '../model/entries';
import {
  EMPTY_SELECTION,
  type SelectionState,
  moveFocus,
  selectOnly,
  selectRange,
  toggleOne,
} from '../model/selection';
import { isApplePlatform, isEditableTarget } from '../model/shortcuts';
import { TYPE_AHEAD_RESET_MS, keyboardIntent, typeAheadStep } from './keyboard-intent';
import { findRow, isCheckTarget, isInertTarget, rowPathOf } from './row-target';
import { useLatestRef } from './use-latest-ref';
import type { ExplorerViewProps } from './view-types';

export interface ViewLayout {
  /** 每行的列数（列表恒为 1） */
  columns: number;
  /** 一行占的高度（含行距），用来折算一页有几行 */
  rowHeight: number;
}

export interface ViewInteractionOptions {
  containerRef: RefObject<HTMLElement | null>;
  props: ExplorerViewProps;
  order: readonly string[];
  byPath: ReadonlyMap<string, FileEntryDto>;
  grid: boolean;
  getLayout: () => ViewLayout;
  /** 框选刚结束时返回 true：随后的那次 click 要吞掉，否则会清空刚框出来的选择 */
  consumeDragClick: () => boolean;
}

export interface ViewInteractionHandlers {
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onDoubleClick: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  /** 触屏复选框 */
  onToggle: (path: string) => void;
}

interface TypeAheadBuffer {
  text: string;
  at: number;
}

interface Context extends ViewInteractionOptions {
  typeAhead: TypeAheadBuffer;
}

export interface ClickModifiers {
  /** ⌘（Apple）/ Ctrl */
  mod: boolean;
  shift: boolean;
}

function modifiersOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) {
  return { mod: isApplePlatform() ? event.metaKey : event.ctrlKey, shift: event.shiftKey };
}

/** 点击一行后的选择：普通 = 只选它，mod = 切换，shift = 从锚点起的区间（再带 mod 则叠加）。 */
export function clickSelection(
  state: SelectionState,
  order: readonly string[],
  path: string,
  modifiers: ClickModifiers
): SelectionState {
  if (modifiers.shift) return selectRange(state, order, path, modifiers.mod);
  if (modifiers.mod) return toggleOne(state, path);
  return selectOnly(path);
}

function entryAt(ctx: Context, target: EventTarget | null): FileEntryDto | null {
  const path = rowPathOf(target);
  return path === null ? null : (ctx.byPath.get(path) ?? null);
}

function hasSelection(state: SelectionState): boolean {
  return state.selected.size > 0 || state.focus !== null || state.anchor !== null;
}

function handleClick(ctx: Context, event: MouseEvent<HTMLElement>): void {
  if (ctx.consumeDragClick()) return;
  if (isInertTarget(event.target) || isCheckTarget(event.target)) return;
  const { props } = ctx;
  const modifiers = modifiersOf(event);
  const entry = entryAt(ctx, event.target);
  if (!entry) {
    // 带修饰键点空白多半是想继续多选时点偏了，不清空
    if (!modifiers.mod && !modifiers.shift && hasSelection(props.selection)) {
      props.onSelectionChange(EMPTY_SELECTION);
    }
    return;
  }
  if (props.coarsePointer) {
    props.onOpen(entry);
    return;
  }
  props.onSelectionChange(clickSelection(props.selection, ctx.order, entry.path, modifiers));
}

function handleDoubleClick(ctx: Context, event: MouseEvent<HTMLElement>): void {
  if (ctx.props.coarsePointer) return;
  if (isInertTarget(event.target) || isCheckTarget(event.target)) return;
  const modifiers = modifiersOf(event);
  if (modifiers.mod || modifiers.shift) return;
  const entry = entryAt(ctx, event.target);
  if (entry) ctx.props.onOpen(entry);
}

function handleContextMenu(ctx: Context, event: MouseEvent<HTMLElement>): void {
  // 编辑框里保留浏览器原生菜单（粘贴 / 拼写）
  if (isEditableTarget(event.target)) return;
  const { props } = ctx;
  const entry = entryAt(ctx, event.target);
  if (entry && !props.selection.selected.has(entry.path)) {
    props.onSelectionChange(selectOnly(entry.path));
  }
  props.onContextMenu(entry, event);
}

function scrollToRow(ctx: Context, path: string | null): void {
  const container = ctx.containerRef.current;
  if (!container || path === null) return;
  findRow(container, path)?.scrollIntoView({ block: 'nearest' });
}

function pageRows(ctx: Context, rowHeight: number): number {
  const height = ctx.containerRef.current?.clientHeight ?? 0;
  if (!(rowHeight > 0) || height <= 0) return 1;
  // 留一行重叠，翻页后还能看到上一页的最后一行
  return Math.max(1, Math.floor(height / rowHeight) - 1);
}

function applySelection(ctx: Context, next: SelectionState): void {
  ctx.props.onSelectionChange(next);
  scrollToRow(ctx, next.focus);
}

function focusIndexOf(ctx: Context): number {
  const cursor = ctx.props.selection.focus ?? ctx.props.selection.anchor;
  return cursor === null ? -1 : ctx.order.indexOf(cursor);
}

function handleTypeAhead(ctx: Context, char: string, timeStamp: number): void {
  const buffer = ctx.typeAhead;
  const previous = timeStamp - buffer.at > TYPE_AHEAD_RESET_MS ? '' : buffer.text;
  const step = typeAheadStep(previous, char, focusIndexOf(ctx));
  if (!step) return;
  buffer.text = step.buffer;
  buffer.at = timeStamp;
  const index = typeAheadMatch(ctx.props.entries, step.prefix, step.fromIndex);
  if (index >= 0) applySelection(ctx, selectOnly(ctx.order[index]));
}

function handleToggleFocus(ctx: Context): void {
  const { selection, onSelectionChange } = ctx.props;
  const cursor = selection.focus ?? selection.anchor;
  if (cursor !== null) onSelectionChange(toggleOne(selection, cursor));
}

function handleKeyDown(ctx: Context, event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || isEditableTarget(event.target)) return;
  const layout = ctx.getLayout();
  const intent = keyboardIntent(event, {
    grid: ctx.grid,
    columns: layout.columns,
    pageRows: pageRows(ctx, layout.rowHeight),
    apple: isApplePlatform(),
  });
  if (!intent) return;
  // 方向键 / 空格的默认行为是滚动容器，这里已经接管
  event.preventDefault();
  if ('toggleFocus' in intent) {
    handleToggleFocus(ctx);
  } else if ('typeAhead' in intent) {
    handleTypeAhead(ctx, intent.typeAhead, event.timeStamp);
  } else if (ctx.order.length > 0) {
    applySelection(
      ctx,
      moveFocus(ctx.props.selection, ctx.order, intent.delta, { extend: intent.extend })
    );
  }
}

export function useViewInteractions(options: ViewInteractionOptions): ViewInteractionHandlers {
  const typeAhead = useRef<TypeAheadBuffer>({ text: '', at: 0 });
  const latest = useLatestRef<Context>({ ...options, typeAhead: typeAhead.current });

  return useMemo<ViewInteractionHandlers>(
    () => ({
      onClick: (event) => handleClick(latest.current, event),
      onDoubleClick: (event) => handleDoubleClick(latest.current, event),
      onContextMenu: (event) => handleContextMenu(latest.current, event),
      onKeyDown: (event) => handleKeyDown(latest.current, event),
      onToggle: (path) => {
        const { selection, onSelectionChange } = latest.current.props;
        onSelectionChange(toggleOne(selection, path));
      },
    }),
    [latest]
  );
}
