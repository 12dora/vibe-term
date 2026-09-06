// 传输弹窗单侧面板的状态机与多选 helper。
//
// 与目录选择器（`directory-picker-modal.tsx`）同一套写法：交互全部收敛成纯 reducer，
// 无 DOM 的单测直接对它断言；区别是这里要列文件 + 目录，并支持复选框多选与 shift 区间选择。

import type { FileEntryDto } from '@tmex/shared';

export interface TransferPaneState {
  /** 运行时 node id（`self` 或 32 位 hex）；未选为 null。 */
  nodeId: string | null;
  rootId: string | null;
  /** 空串表示 root 自身的路径，由后端解析后回填。 */
  path: string;
  draft: string;
  highlight: number;
  hidden: boolean;
  /** 已勾选条目的绝对路径。 */
  selection: ReadonlySet<string>;
  /** shift 区间选择的锚点下标。 */
  anchor: number | null;
}

export type TransferPaneAction =
  | { type: 'selectNode'; nodeId: string }
  | { type: 'selectRoot'; rootId: string }
  | { type: 'navigate'; path: string }
  | { type: 'draft'; value: string }
  | { type: 'submitDraft' }
  | { type: 'sync'; path: string }
  | { type: 'highlight'; index: number }
  | { type: 'move'; delta: number; count: number }
  | { type: 'toggleHidden'; hidden: boolean }
  | { type: 'toggle'; index: number; path: string }
  | { type: 'range'; index: number; paths: readonly string[] }
  | { type: 'prune'; paths: readonly string[] }
  | { type: 'clearSelection' };

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

export function createTransferPaneState(nodeId: string | null = null): TransferPaneState {
  return {
    nodeId,
    rootId: null,
    path: '',
    draft: '',
    highlight: -1,
    hidden: false,
    selection: EMPTY_SELECTION,
    anchor: null,
  };
}

export function toggleSelection(selection: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(selection);
  if (!next.delete(path)) next.add(path);
  return next;
}

/** shift 区间：锚点到当前下标之间全部加选（不取消已选的其它项）。 */
export function rangeSelection(
  selection: ReadonlySet<string>,
  paths: readonly string[],
  anchor: number,
  index: number
): ReadonlySet<string> {
  const from = Math.max(0, Math.min(anchor, index));
  const to = Math.min(paths.length - 1, Math.max(anchor, index));
  if (to < from) return selection;
  const next = new Set(selection);
  for (let i = from; i <= to; i += 1) next.add(paths[i]);
  return next;
}

/** 摘掉当前目录里已经不存在的路径；没有变化时返回原引用。 */
export function pruneSelection(
  selection: ReadonlySet<string>,
  paths: readonly string[]
): ReadonlySet<string> {
  const alive = new Set(paths);
  const next = new Set([...selection].filter((path) => alive.has(path)));
  return next.size === selection.size ? selection : next;
}

/** 键盘上下移动高亮；-1 表示未高亮，越界按边界夹紧。 */
export function moveHighlight(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  const next = current + delta;
  if (next < 0) return 0;
  return next > count - 1 ? count - 1 : next;
}

function navigated(state: TransferPaneState, path: string): TransferPaneState {
  return {
    ...state,
    path,
    draft: path,
    highlight: -1,
    selection: EMPTY_SELECTION,
    anchor: null,
  };
}

function selectionAction(
  state: TransferPaneState,
  action: Extract<TransferPaneAction, { type: 'toggle' | 'range' | 'prune' | 'clearSelection' }>
): TransferPaneState {
  switch (action.type) {
    case 'toggle':
      return {
        ...state,
        selection: toggleSelection(state.selection, action.path),
        anchor: action.index,
        highlight: action.index,
      };
    case 'range': {
      const anchor = state.anchor ?? action.index;
      return {
        ...state,
        selection: rangeSelection(state.selection, action.paths, anchor, action.index),
        highlight: action.index,
      };
    }
    case 'prune': {
      const selection = pruneSelection(state.selection, action.paths);
      return selection === state.selection ? state : { ...state, selection };
    }
    case 'clearSelection':
      return state.selection.size === 0
        ? state
        : { ...state, selection: EMPTY_SELECTION, anchor: null };
  }
}

export function transferPaneReducer(
  state: TransferPaneState,
  action: TransferPaneAction
): TransferPaneState {
  switch (action.type) {
    case 'selectNode':
      return state.nodeId === action.nodeId ? state : createTransferPaneState(action.nodeId);
    case 'selectRoot':
      return state.rootId === action.rootId
        ? state
        : { ...createTransferPaneState(state.nodeId), rootId: action.rootId, hidden: state.hidden };
    case 'navigate':
      return navigated(state, action.path);
    case 'draft':
      return { ...state, draft: action.value };
    case 'submitDraft': {
      const next = state.draft.trim();
      return next.startsWith('/') ? navigated(state, next) : state;
    }
    case 'sync':
      return state.path === action.path && state.draft === action.path
        ? state
        : { ...state, path: action.path, draft: action.path };
    case 'highlight':
      return { ...state, highlight: action.index };
    case 'move':
      return { ...state, highlight: moveHighlight(action.count, state.highlight, action.delta) };
    case 'toggleHidden':
      return { ...state, hidden: action.hidden, highlight: -1 };
    default:
      return selectionAction(state, action);
  }
}

// ---------------------------------------------------------------------------
// 条目列表
// ---------------------------------------------------------------------------

export function isDirectoryEntry(entry: FileEntryDto): boolean {
  return entry.type === 'dir' || entry.category === 'directory';
}

function isHiddenEntry(entry: FileEntryDto): boolean {
  return entry.name.startsWith('.');
}

/**
 * 列表 API 不认 `hidden` 参数，隐藏文件在前端过滤；目录在前、同类按名。
 */
export function visibleEntries(entries: readonly FileEntryDto[], hidden: boolean): FileEntryDto[] {
  const kept = hidden ? [...entries] : entries.filter((entry) => !isHiddenEntry(entry));
  return kept.sort((a, b) => {
    const dirA = isDirectoryEntry(a);
    if (dirA !== isDirectoryEntry(b)) return dirA ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/** `/a/b` → 上一级 `/a`；根目录没有上一级。 */
export function parentPath(path: string): string | null {
  if (!path.startsWith('/') || path === '/') return null;
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) return null;
  return cut === 0 ? '/' : trimmed.slice(0, cut);
}

export interface TransferBreadcrumb {
  label: string;
  path: string;
}

export function transferBreadcrumbs(path: string): TransferBreadcrumb[] {
  if (!path.startsWith('/')) return [];
  const crumbs: TransferBreadcrumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const segment of path.split('/').filter(Boolean)) {
    acc += `/${segment}`;
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

// ---------------------------------------------------------------------------
// 发送前置条件
// ---------------------------------------------------------------------------

/** 发送按钮不可点的原因；可点时为 null。 */
export type SendBlock = 'incomplete' | 'noSelection' | 'sameLocation';

export function sendBlock(source: TransferPaneState, dest: TransferPaneState): SendBlock | null {
  if (!source.nodeId || !source.rootId || !dest.nodeId || !dest.rootId) return 'incomplete';
  if (!dest.path.startsWith('/')) return 'incomplete';
  if (source.selection.size === 0) return 'noSelection';
  const sameRoot = source.nodeId === dest.nodeId && source.rootId === dest.rootId;
  if (sameRoot && source.path === dest.path) return 'sameLocation';
  return null;
}
