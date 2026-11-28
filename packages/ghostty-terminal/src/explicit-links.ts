import { type FileLinkContext, resolveValidFilePath } from './file-path';
import type { TerminalLinkHit, TerminalLinkTarget } from './terminal-pointer-shared';
import type { GhosttyRenderCell, GhosttyRenderRow } from './types';

export const MAX_EXPLICIT_URI_LENGTH = 4096;

/** 一行内 URI 相同的连续 OSC 8 格子；uri 为空表示该段不可打开（超长被拒，或此刻读不到）。 */
export type ExplicitLinkSpan = {
  startCol: number;
  endCol: number;
  uri: string;
  text: string;
  resolved?: { context: FileLinkContext | null; hit: TerminalLinkHit | null };
};

/** 绝对行号 → 该行的 explicit 段；不可见或无 OSC 8 的行返回空数组。 */
export type ExplicitLinkSource = (line: number) => readonly ExplicitLinkSpan[];

/**
 * ghostty 视口：viewport() 给出当前视口顶的绝对行号与视口行数；uriAt 按视口坐标读 URI，
 * 返回 '' 表示 URI 存在但被拒（超长，结果可缓存），null 表示读不到（结果不可缓存）。
 */
export type ExplicitLinkGrid = {
  viewport(): { offset: number; rows: number };
  uriAt(x: number, y: number): string | null;
  dispose(): void;
};

export type ExplicitRowSpans = { spans: ExplicitLinkSpan[]; complete: boolean };

// new URL() 会静默剥离首尾空白与 C0/DEL 控制字符，原串却会原样交给宿主打开：一律拒绝。
function hasUnsafeChars(uri: string): boolean {
  if (uri.trim() !== uri) {
    return true;
  }
  for (let index = 0; index < uri.length; index += 1) {
    const code = uri.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const EMPTY_SPANS: readonly ExplicitLinkSpan[] = [];

// http/https → url（URI 原样）；file: → 取 pathname 解码后按 cwd/授权根校验；其余 scheme 一律不是链接。
export function classifyExplicitUri(
  uri: string,
  context: FileLinkContext | null
): TerminalLinkTarget | null {
  if (uri.length === 0 || uri.length > MAX_EXPLICIT_URI_LENGTH || hasUnsafeChars(uri)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { kind: 'url', url: uri };
  }
  if (parsed.protocol !== 'file:') {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const resolved = resolveValidFilePath(path, context);
  return resolved ? { kind: 'file', path: resolved } : null;
}

export function explicitSpanHit(
  span: ExplicitLinkSpan,
  context: FileLinkContext | null
): TerminalLinkHit | null {
  if (span.resolved && span.resolved.context === context) {
    return span.resolved.hit;
  }
  const target = classifyExplicitUri(span.uri, context);
  let hit: TerminalLinkHit | null = null;
  if (target) {
    hit = { ...target, explicit: true };
    if (target.kind === 'url' && span.text.trim() !== span.uri) {
      hit.tooltip = span.uri;
    }
  }
  span.resolved = { context, hit };
  return hit;
}

export function explicitSpanAt(
  spans: readonly ExplicitLinkSpan[],
  col: number
): ExplicitLinkSpan | null {
  for (const span of spans) {
    if (col >= span.startCol && col <= span.endCol) {
      return span;
    }
  }
  return null;
}

export function overlapsExplicitSpan(
  spans: readonly ExplicitLinkSpan[],
  startCol: number,
  endCol: number
): boolean {
  return spans.some((span) => span.startCol <= endCol && span.endCol >= startCol);
}

function cellText(cell: GhosttyRenderCell): string {
  if (cell.text) {
    return cell.text;
  }
  return cell.widthKind === 'narrow' ? ' ' : '';
}

// 宽字符的 spacer-tail 若未带标记，跟随前一格并入同一段；行尾 spacer-head 是宽字符折到下一行
// 留下的空占位，不属于任何链接。readUri 为 null 或某格读回 null 时 complete=false：带标记的
// 格子仍成段（压制正则检测），但 uri 为空、不可打开，且整行结果不得缓存。
export function buildExplicitSpans(
  cells: readonly GhosttyRenderCell[],
  readUri: ((col: number) => string | null) | null
): ExplicitRowSpans {
  const spans: ExplicitLinkSpan[] = [];
  let complete = readUri !== null;
  let current: ExplicitLinkSpan | null = null;
  for (const cell of cells) {
    if (cell.widthKind === 'spacer-head' || !cell.hasHyperlink) {
      current = continueWithSpacer(current, cell);
      continue;
    }
    const read = readUri ? readUri(cell.x) : null;
    complete &&= read !== null;
    const uri = read ?? '';
    if (current && current.uri === uri && current.endCol === cell.x - 1) {
      current.endCol = cell.x;
      current.text += cellText(cell);
      continue;
    }
    current = { startCol: cell.x, endCol: cell.x, uri, text: cellText(cell) };
    spans.push(current);
  }
  return { spans, complete };
}

function continueWithSpacer(
  current: ExplicitLinkSpan | null,
  cell: GhosttyRenderCell
): ExplicitLinkSpan | null {
  if (!current || cell.widthKind !== 'spacer-tail' || current.endCol !== cell.x - 1) {
    return null;
  }
  current.endCol = cell.x;
  return current;
}

// 按 cells 数组身份缓存每行的 explicit 段：render-state 对内容未变的行复用同一数组，
// 内容（含 hyperlink 标记）一变即换新数组、自动失效。无标记的行只付一次扫描。
// 只在内核网格与最近一帧渲染一致（synced）时才查内核并缓存：内核已有未渲染的写入 /
// resize / reset 时，旧行身份可能在下一帧被原样复用，此刻读到的 URI 会把缓存永久毒化。
export class ExplicitLinkIndex {
  private readonly byCells = new WeakMap<GhosttyRenderCell[], readonly ExplicitLinkSpan[]>();

  constructor(private readonly grid: ExplicitLinkGrid) {}

  // rows / offset 是最近一帧渲染的视口；ghostty 视口若在渲染后又滚动过（滚动不改网格内容），
  // 按当前视口顶换算出同一绝对行的视口坐标再查；换算后不在当前视口内的行本次不缓存。
  source(rows: readonly GhosttyRenderRow[], offset: number, synced: boolean): ExplicitLinkSource {
    let viewport: { offset: number; rows: number } | null = null;
    return (line) => {
      const row = rows[line - offset];
      if (!row) {
        return EMPTY_SPANS;
      }
      const cached = this.byCells.get(row.cells);
      if (cached) {
        return cached;
      }
      if (!row.cells.some((cell) => cell.hasHyperlink)) {
        this.byCells.set(row.cells, EMPTY_SPANS);
        return EMPTY_SPANS;
      }
      if (!synced) {
        return buildExplicitSpans(row.cells, null).spans;
      }
      viewport ??= this.grid.viewport();
      const gridY = line - viewport.offset;
      const readable = gridY >= 0 && gridY < viewport.rows;
      const result = buildExplicitSpans(
        row.cells,
        readable ? (col) => this.grid.uriAt(col, gridY) : null
      );
      if (result.complete) {
        this.byCells.set(row.cells, result.spans);
      }
      return result.spans;
    };
  }

  dispose(): void {
    this.grid.dispose();
  }
}
