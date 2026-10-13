// 视图键盘导航的纯逻辑：按键 + 布局 → 意图。命令类快捷键（Enter / Delete / F2 / mod+A…）
// 不在这里处理，命中命令表的按键一律返回 null，留给上层的键盘钩子。

import { type ExplorerKeyEvent, matchExplorerCommand } from '../model/shortcuts';

export interface KeyboardLayout {
  /** 图标视图：四个方向键都可用；列表视图只认上下 */
  grid: boolean;
  /** 每行的列数（列表恒为 1） */
  columns: number;
  /** 一页（可视区域）的行数 */
  pageRows: number;
  apple: boolean;
}

export type KeyboardIntent =
  | { delta: number; extend: boolean }
  | { typeAhead: string }
  | { toggleFocus: true }
  | null;

/** 输入间隔超过这个时长，按名称定位的缓冲清空 */
export const TYPE_AHEAD_RESET_MS = 500;

function moveDelta(key: string, layout: KeyboardLayout): number | null {
  const columns = layout.grid ? Math.max(1, layout.columns) : 1;
  const page = Math.max(1, layout.pageRows) * columns;
  const deltas = new Map<string, number>([
    ['ArrowUp', -columns],
    ['ArrowDown', columns],
    ['Home', Number.NEGATIVE_INFINITY],
    ['End', Number.POSITIVE_INFINITY],
    ['PageUp', -page],
    ['PageDown', page],
  ]);
  if (layout.grid) {
    deltas.set('ArrowLeft', -1);
    deltas.set('ArrowRight', 1);
  }
  return deltas.get(key) ?? null;
}

export function keyboardIntent(event: ExplorerKeyEvent, layout: KeyboardLayout): KeyboardIntent {
  const anyMod = event.ctrlKey || event.metaKey;
  if (event.key === ' ' && anyMod && !event.altKey) return { toggleFocus: true };
  if (anyMod || event.altKey) return null;
  if (matchExplorerCommand(event, layout.apple) !== null) return null;
  const delta = moveDelta(event.key, layout);
  if (delta !== null) return { delta, extend: event.shiftKey };
  // 输入法合成中的 key 是 'Process' 之类的多字符名，自然被排除
  if ([...event.key].length === 1) return { typeAhead: event.key };
  return null;
}

export interface TypeAheadStep {
  /** 新的缓冲内容 */
  buffer: string;
  /** 用来匹配名称前缀的串 */
  prefix: string;
  /** 交给 `typeAheadMatch` 的起点（含） */
  fromIndex: number;
}

function isSingleLetterRun(text: string): boolean {
  const chars = [...text.toLowerCase()];
  return chars.every((char) => char === chars[0]);
}

/**
 * 缓冲里追加一个字符后该怎么找：
 * 同一个字母连按 → 只按这一个字母匹配，从光标的下一项起找，于是逐次轮转到下一个匹配；
 * 其余情况按整段前缀匹配，从光标所在项（含）起找，光标项仍匹配时不动。
 * 空缓冲遇到空格不算输入。
 */
export function typeAheadStep(
  buffer: string,
  char: string,
  focusIndex: number
): TypeAheadStep | null {
  if (buffer === '' && char.trim() === '') return null;
  const next = buffer + char;
  if (isSingleLetterRun(next)) return { buffer: next, prefix: char, fromIndex: focusIndex + 1 };
  return { buffer: next, prefix: next, fromIndex: Math.max(0, focusIndex) };
}

/**
 * 从网格的 computed `grid-template-columns`（解析后的轨道列表，如 `104.8px 104.8px`）
 * 读出真实列数；取不到（`none`、非像素轨道、空串）返回 null。
 */
export function columnsFromTemplate(template: string | null | undefined): number | null {
  const tracks = (template ?? '').trim().split(/\s+/).filter(Boolean);
  if (tracks.length === 0) return null;
  return tracks.every((track) => /^\d*\.?\d+px$/.test(track)) ? tracks.length : null;
}

/**
 * 按宽度估算一行能排下几列：`(inner + gap) / (tile + gap)`，至少 1。
 * 只作兜底：`tileWidth` 多半来自取整后的 offsetWidth，亚像素列宽下会少算一列，
 * 优先用 `columnsFromTemplate`。
 */
export function gridColumnCount(innerWidth: number, tileWidth: number, gap: number): number {
  if (!(tileWidth > 0) || !(innerWidth > 0)) return 1;
  // 亚像素取整误差留 0.5px 余量
  return Math.max(1, Math.floor((innerWidth + gap + 0.5) / (tileWidth + gap)));
}
