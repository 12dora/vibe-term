import { INTERN_LIMIT } from './render-state-color';
import type {
  GhosttyCellWidthKind,
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
} from './types';

const EMPTY_CODEPOINTS: number[] = [];
const ASCII_TEXT: string[] = [];
const ASCII_CODEPOINTS: number[][] = [];
for (let codepoint = 0; codepoint < 128; codepoint += 1) {
  ASCII_TEXT.push(String.fromCharCode(codepoint));
  ASCII_CODEPOINTS.push([codepoint]);
}

// readRowCells 每格读出的字段先落进这个复用对象：同一份数据既做复用比对、又在变化时
// 物化成新 cell，避免两处各写一遍字段清单而漏掉新字段（如 hasHyperlink）。
export type CellProbe = {
  text: string;
  codepointCount: number;
  widthKind: GhosttyCellWidthKind;
  hasText: boolean;
  hasHyperlink: boolean;
  style: GhosttyRenderCellStyle;
  fgColor: GhosttyColorRgb | null;
  bgColor: GhosttyColorRgb | null;
};

export function createCellProbe(): CellProbe {
  return {
    text: '',
    codepointCount: 0,
    widthKind: 'narrow',
    hasText: false,
    hasHyperlink: false,
    style: internStyle(new Map(), 0, 0, 0),
    fgColor: null,
    bgColor: null,
  };
}

// style / 颜色均为内插实例，引用相等即内容相等；按位与避免逐字段短路分支。
export function isCellUnchanged(candidate: GhosttyRenderCell, probe: CellProbe): boolean {
  return (
    (Number(candidate.text === probe.text) &
      Number(candidate.codepoints.length === probe.codepointCount) &
      Number(candidate.widthKind === probe.widthKind) &
      Number(candidate.hasText === probe.hasText) &
      Number(candidate.hasHyperlink === probe.hasHyperlink) &
      Number(candidate.style === probe.style) &
      Number(candidate.fgColor === probe.fgColor) &
      Number(candidate.bgColor === probe.bgColor)) !==
    0
  );
}

export function materializeCell(x: number, probe: CellProbe, buffer: number[]): GhosttyRenderCell {
  return {
    x,
    text: probe.text,
    codepoints: materializeCodepoints(buffer, probe.codepointCount),
    widthKind: probe.widthKind,
    hasText: probe.hasText,
    hasHyperlink: probe.hasHyperlink,
    style: probe.style,
    fgColor: probe.fgColor,
    bgColor: probe.bgColor,
  };
}

export function internStyle(
  styleCache: Map<number, GhosttyRenderCellStyle>,
  key: number,
  flags: number,
  underline: number
): GhosttyRenderCellStyle {
  if (styleCache.size >= INTERN_LIMIT) {
    styleCache.clear();
  }
  const style: GhosttyRenderCellStyle = {
    bold: (flags & 0b0000_0001) !== 0,
    italic: (flags & 0b0000_0010) !== 0,
    faint: (flags & 0b0000_0100) !== 0,
    blink: (flags & 0b0000_1000) !== 0,
    inverse: (flags & 0b0001_0000) !== 0,
    invisible: (flags & 0b0010_0000) !== 0,
    strikethrough: (flags & 0b0100_0000) !== 0,
    overline: (flags & 0b1000_0000) !== 0,
    underline,
  };
  styleCache.set(key, style);
  return style;
}

export function codepointsToText(buffer: number[], length: number): string {
  if (length === 0) {
    return '';
  }
  if (length === 1 && buffer[0] < 128) {
    return ASCII_TEXT[buffer[0]];
  }
  try {
    return String.fromCodePoint(...buffer.slice(0, length));
  } catch {
    return '';
  }
}

function materializeCodepoints(buffer: number[], length: number): number[] {
  if (length === 0) {
    return EMPTY_CODEPOINTS;
  }
  if (length === 1 && buffer[0] < 128) {
    return ASCII_CODEPOINTS[buffer[0]];
  }
  return buffer.slice(0, length);
}

export function buildRowText(cells: GhosttyRenderCell[]): string {
  let text = '';
  for (const cell of cells) {
    if (cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head') {
      continue;
    }
    if (cell.text) {
      text += cell.text;
      continue;
    }
    if (cell.widthKind === 'narrow') {
      text += ' ';
    }
  }
  return text;
}

export function reuseUnchangedRow(
  previous: GhosttyRenderRow | null,
  rowIndex: number,
  cellCount: number,
  wrap: boolean,
  wrapContinuation: boolean
): GhosttyRenderRow | null {
  if (
    !previous ||
    previous.cells.length !== cellCount ||
    previous.wrap !== wrap ||
    previous.wrapContinuation !== wrapContinuation
  ) {
    return null;
  }
  if (!previous.dirty && previous.y === rowIndex) {
    return previous;
  }
  return {
    y: rowIndex,
    dirty: false,
    wrap,
    wrapContinuation,
    text: previous.text,
    cells: previous.cells,
  };
}
