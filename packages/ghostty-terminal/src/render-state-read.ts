import type { GhosttyBindings } from './ghostty-wasm';
import type { GhosttyRenderStateResources } from './render-state';
import { INTERN_LIMIT, internColorByKey } from './render-state-color';
import type {
  GhosttyCellWidthKind,
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
} from './types';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_INVALID_VALUE = -2;

const GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY = 1;
const GHOSTTY_RENDER_STATE_ROW_DATA_RAW = 2;

const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW = 1;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE = 2;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN = 3;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF = 4;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR = 5;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR = 6;

const GHOSTTY_ROW_DATA_WRAP = 1;
const GHOSTTY_ROW_DATA_WRAP_CONTINUATION = 2;
const GHOSTTY_CELL_DATA_WIDE = 3;
const GHOSTTY_CELL_DATA_HAS_TEXT = 4;

const ROW_CELL_BATCH_COUNT = 5;
const RAW_CELL_BATCH_COUNT = 2;
const GRAPHEME_SCRATCH_CODEPOINTS = 64;

const STYLE_FLAG_FIELDS = [
  'bold',
  'italic',
  'faint',
  'blink',
  'inverse',
  'invisible',
  'strikethrough',
  'overline',
] as const;

const EMPTY_CODEPOINTS: number[] = [];
const ASCII_TEXT: string[] = [];
const ASCII_CODEPOINTS: number[][] = [];
for (let codepoint = 0; codepoint < 128; codepoint += 1) {
  ASCII_TEXT.push(String.fromCharCode(codepoint));
  ASCII_CODEPOINTS.push([codepoint]);
}

const CELL_WIDTH_KINDS: GhosttyCellWidthKind[] = ['narrow', 'wide', 'spacer-tail', 'spacer-head'];
const graphemeScratch: number[] = new Array(GRAPHEME_SCRATCH_CODEPOINTS).fill(0);

export type RenderStateScratch = {
  base: number;
  size: number;
  u32: number;
  u8: number;
  cellRaw: number;
  cellGraphemeLen: number;
  cellStyle: number;
  cellFg: number;
  cellBg: number;
  rawCellWide: number;
  rawCellHasText: number;
  rowCellKeys: number;
  rowCellValues: number;
  rawCellKeys: number;
  rawCellValues: number;
  multiWritten: number;
  colors: number;
  graphemes: number;
  colorsSize: number;
  styleSize: number;
  styleSizeOffset: number;
  styleFlagOffsets: number[];
  styleUnderlineOffset: number;
  colorsPaletteOffset: number;
  colorsBackgroundOffset: number;
  colorsForegroundOffset: number;
  colorsCursorOffset: number;
  colorsCursorHasValueOffset: number;
};

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function writeBatchLayout(
  view: DataView,
  keysPtr: number,
  valuesPtr: number,
  keys: readonly number[],
  values: readonly number[]
): void {
  for (let index = 0; index < keys.length; index += 1) {
    view.setUint32(keysPtr + index * 4, keys[index], true);
    view.setUint32(valuesPtr + index * 4, values[index], true);
  }
}

export function ensureRenderStateScratch(
  resources: GhosttyRenderStateResources
): RenderStateScratch {
  if (resources.scratch) {
    return resources.scratch;
  }

  const bindings = resources.bindings;
  const styleSize = bindings.typeSize('GhosttyStyle');
  const colorSize = bindings.typeSize('GhosttyColorRgb');
  const colorsSize = bindings.typeSize('GhosttyRenderStateColors');
  const styleOffset = 16;
  const fgOffset = styleOffset + styleSize;
  const bgOffset = fgOffset + colorSize;
  const rawCellWideOffset = alignUp(bgOffset + colorSize, 4);
  const rawCellHasTextOffset = rawCellWideOffset + 4;
  const rowCellKeysOffset = alignUp(rawCellHasTextOffset + 1, 4);
  const rowCellValuesOffset = rowCellKeysOffset + ROW_CELL_BATCH_COUNT * 4;
  const rawCellKeysOffset = rowCellValuesOffset + ROW_CELL_BATCH_COUNT * 4;
  const rawCellValuesOffset = rawCellKeysOffset + RAW_CELL_BATCH_COUNT * 4;
  const multiWrittenOffset = rawCellValuesOffset + RAW_CELL_BATCH_COUNT * 4;
  const colorsOffset = alignUp(multiWrittenOffset + 4, 8);
  const graphemesOffset = alignUp(colorsOffset + colorsSize, 8);
  const usedSize = graphemesOffset + GRAPHEME_SCRATCH_CODEPOINTS * 4;
  const allocationSize = usedSize + 8;
  const base = bindings.allocBytes(allocationSize);
  const aligned = alignUp(base, 8);

  const scratch: RenderStateScratch = {
    base,
    size: allocationSize,
    u32: aligned + 8,
    u8: aligned + 12,
    cellRaw: aligned,
    cellGraphemeLen: aligned + 8,
    cellStyle: aligned + styleOffset,
    cellFg: aligned + fgOffset,
    cellBg: aligned + bgOffset,
    rawCellWide: aligned + rawCellWideOffset,
    rawCellHasText: aligned + rawCellHasTextOffset,
    rowCellKeys: aligned + rowCellKeysOffset,
    rowCellValues: aligned + rowCellValuesOffset,
    rawCellKeys: aligned + rawCellKeysOffset,
    rawCellValues: aligned + rawCellValuesOffset,
    multiWritten: aligned + multiWrittenOffset,
    colors: aligned + colorsOffset,
    graphemes: aligned + graphemesOffset,
    colorsSize,
    styleSize,
    styleSizeOffset: bindings.field('GhosttyStyle', 'size').offset,
    styleFlagOffsets: STYLE_FLAG_FIELDS.map((name) => bindings.field('GhosttyStyle', name).offset),
    styleUnderlineOffset: bindings.field('GhosttyStyle', 'underline').offset,
    colorsPaletteOffset: bindings.field('GhosttyRenderStateColors', 'palette').offset,
    colorsBackgroundOffset: bindings.field('GhosttyRenderStateColors', 'background').offset,
    colorsForegroundOffset: bindings.field('GhosttyRenderStateColors', 'foreground').offset,
    colorsCursorOffset: bindings.field('GhosttyRenderStateColors', 'cursor').offset,
    colorsCursorHasValueOffset: bindings.field('GhosttyRenderStateColors', 'cursor_has_value')
      .offset,
  };

  const view = bindings.view();
  writeBatchLayout(
    view,
    scratch.rowCellKeys,
    scratch.rowCellValues,
    [
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
    ],
    [scratch.cellRaw, scratch.cellGraphemeLen, scratch.cellStyle, scratch.cellFg, scratch.cellBg]
  );
  writeBatchLayout(
    view,
    scratch.rawCellKeys,
    scratch.rawCellValues,
    [GHOSTTY_CELL_DATA_WIDE, GHOSTTY_CELL_DATA_HAS_TEXT],
    [scratch.rawCellWide, scratch.rawCellHasText]
  );
  resources.scratch = scratch;
  return scratch;
}

export function releaseRenderStateScratch(resources: GhosttyRenderStateResources): void {
  const scratch = resources.scratch;
  if (!scratch) {
    return;
  }
  resources.bindings.freeBytes(scratch.base, scratch.size);
  resources.scratch = null;
}

function throwRowCellBatchError(result: number, written: number): never {
  switch (written) {
    case 0:
      throw new Error(`ghostty u64 read failed with result ${result}`);
    case 1:
      throw new Error(`ghostty u32 read failed with result ${result}`);
    case 2:
      throw new Error(`ghostty_render_state_row_cells_get failed with result ${result}`);
    default:
      throw new Error(`ghostty optional color read failed with result ${result}`);
  }
}

function throwRawCellBatchError(result: number, written: number): never {
  if (written === 0) {
    throw new Error(`ghostty enum read failed with result ${result}`);
  }
  throw new Error(`ghostty bool read failed with result ${result}`);
}

function internStyle(
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

function codepointsToText(buffer: number[], length: number): string {
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

function readGraphemeText(
  bindings: GhosttyBindings,
  rowCellsHandle: number,
  scratch: RenderStateScratch,
  heldView: DataView,
  graphemeLen: number
): string {
  if (graphemeLen === 0) {
    return '';
  }

  const inline = graphemeLen <= GRAPHEME_SCRATCH_CODEPOINTS;
  const allocationSize = inline ? 0 : graphemeLen * 4;
  const bufPtr = inline ? scratch.graphemes : bindings.allocBytes(allocationSize);
  const view = inline ? heldView : bindings.view();
  try {
    const result = bindings.getRenderStateRowCellValueResult(
      rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
      bufPtr
    );
    if (result !== GHOSTTY_SUCCESS) {
      throw new Error(`ghostty_render_state_row_cells_get failed with result ${result}`);
    }
    for (let index = 0; index < graphemeLen; index += 1) {
      graphemeScratch[index] = view.getUint32(bufPtr + index * 4, true);
    }
    return codepointsToText(graphemeScratch, graphemeLen);
  } finally {
    if (!inline) {
      bindings.freeBytes(bufPtr, allocationSize);
    }
  }
}

function readSkippedBackground(
  bindings: GhosttyBindings,
  rowCellsHandle: number,
  outPtr: number
): boolean {
  const result = bindings.getRenderStateRowCellValueResult(
    rowCellsHandle,
    GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
    outPtr
  );
  if (result === GHOSTTY_SUCCESS) {
    return true;
  }
  if (result === GHOSTTY_INVALID_VALUE) {
    return false;
  }
  throw new Error(`ghostty optional color read failed with result ${result}`);
}

function buildRowText(cells: GhosttyRenderCell[]): string {
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

export function isCellUnchanged(
  candidate: GhosttyRenderCell,
  text: string,
  codepointCount: number,
  widthKind: GhosttyCellWidthKind,
  hasText: boolean,
  style: GhosttyRenderCellStyle,
  fgColor: GhosttyColorRgb | null,
  bgColor: GhosttyColorRgb | null
): boolean {
  return (
    candidate.text === text &&
    candidate.codepoints.length === codepointCount &&
    candidate.widthKind === widthKind &&
    candidate.hasText === hasText &&
    candidate.style === style &&
    candidate.fgColor === fgColor &&
    candidate.bgColor === bgColor
  );
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

function readRowCells(
  resources: GhosttyRenderStateResources,
  scratch: RenderStateScratch,
  previousCells: GhosttyRenderCell[] | null,
  cells: GhosttyRenderCell[]
): boolean {
  const { bindings, rowCellsHandle, styleCache, colorCache } = resources;
  const wasm = bindings.exports;
  const stylePtr = scratch.cellStyle;
  let view = bindings.view();
  let changed = false;
  let x = 0;

  while (bindings.nextRenderStateRowCell(rowCellsHandle)) {
    view.setUint32(stylePtr + scratch.styleSizeOffset, scratch.styleSize, true);
    const batchResult = wasm.ghostty_render_state_row_cells_get_multi(
      rowCellsHandle,
      ROW_CELL_BATCH_COUNT,
      scratch.rowCellKeys,
      scratch.rowCellValues,
      scratch.multiWritten
    );
    const batchWritten = view.getUint32(scratch.multiWritten, true);
    // get_multi 在首个缺失的可选色停止；FG 缺失时 BG 尚未读取，后面单独补读。
    if (batchResult !== GHOSTTY_SUCCESS) {
      if (batchResult !== GHOSTTY_INVALID_VALUE || batchWritten < 3) {
        throwRowCellBatchError(batchResult, batchWritten);
      }
    }

    const rawCell = view.getBigUint64(scratch.cellRaw, true);
    const codepointCount = view.getUint32(scratch.cellGraphemeLen, true);
    const text = readGraphemeText(bindings, rowCellsHandle, scratch, view, codepointCount);
    if (codepointCount > GRAPHEME_SCRATCH_CODEPOINTS) {
      view = bindings.view();
    }

    const rawResult = wasm.ghostty_cell_get_multi(
      rawCell,
      RAW_CELL_BATCH_COUNT,
      scratch.rawCellKeys,
      scratch.rawCellValues,
      scratch.multiWritten
    );
    if (rawResult !== GHOSTTY_SUCCESS) {
      throwRawCellBatchError(rawResult, view.getUint32(scratch.multiWritten, true));
    }
    const widthKind = CELL_WIDTH_KINDS[view.getInt32(scratch.rawCellWide, true)] ?? 'narrow';
    const hasText = view.getUint8(scratch.rawCellHasText) !== 0;

    let flags = 0;
    for (let index = 0; index < scratch.styleFlagOffsets.length; index += 1) {
      flags |= Number(view.getUint8(stylePtr + scratch.styleFlagOffsets[index]) !== 0) << index;
    }
    const underline = view.getInt32(stylePtr + scratch.styleUnderlineOffset, true);
    const styleKey = underline * 256 + flags;
    let style = styleCache.get(styleKey);
    style ??= internStyle(styleCache, styleKey, flags, underline);

    let fgColor: GhosttyColorRgb | null = null;
    if (batchWritten > 3) {
      const red = view.getUint8(scratch.cellFg);
      const green = view.getUint8(scratch.cellFg + 1);
      const blue = view.getUint8(scratch.cellFg + 2);
      const colorKey = (red << 16) | (green << 8) | blue;
      fgColor = internColorByKey(colorCache, colorKey, red, green, blue);
    }

    let bgAvailable = batchWritten > 4;
    if (batchWritten === 3) {
      bgAvailable = readSkippedBackground(bindings, rowCellsHandle, scratch.cellBg);
    }
    let bgColor: GhosttyColorRgb | null = null;
    if (bgAvailable) {
      const red = view.getUint8(scratch.cellBg);
      const green = view.getUint8(scratch.cellBg + 1);
      const blue = view.getUint8(scratch.cellBg + 2);
      const colorKey = (red << 16) | (green << 8) | blue;
      bgColor = internColorByKey(colorCache, colorKey, red, green, blue);
    }

    const reusable = previousCells?.[x];
    if (
      reusable &&
      (Number(reusable.text === text) &
        Number(reusable.codepoints.length === codepointCount) &
        Number(reusable.widthKind === widthKind) &
        Number(reusable.hasText === hasText) &
        Number(reusable.style === style) &
        Number(reusable.fgColor === fgColor) &
        Number(reusable.bgColor === bgColor)) !==
        0
    ) {
      cells.push(reusable);
    } else {
      changed = true;
      cells.push({
        x,
        text,
        codepoints: materializeCodepoints(graphemeScratch, codepointCount),
        widthKind,
        hasText,
        style,
        fgColor,
        bgColor,
      });
    }
    x += 1;
  }
  return changed;
}

function consumeReportedRowDirty(
  resources: GhosttyRenderStateResources,
  scratch: RenderStateScratch,
  view: DataView
): boolean {
  const { bindings, rowIteratorHandle } = resources;
  const result = bindings.getRenderStateRowValueResult(
    rowIteratorHandle,
    GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
    scratch.u8
  );
  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty bool read failed with result ${result}`);
  }
  if (view.getUint8(scratch.u8) === 0) {
    return false;
  }
  view.setUint8(scratch.u8, 0);
  bindings.setRenderStateRowValue(
    rowIteratorHandle,
    GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
    scratch.u8
  );
  return true;
}

export function readRenderStateRow(
  resources: GhosttyRenderStateResources,
  rowIndex: number,
  previous: GhosttyRenderRow | null,
  reuseReportedDirty = false
): GhosttyRenderRow {
  const scratch = ensureRenderStateScratch(resources);
  const { bindings, rowIteratorHandle, rowCellsHandle } = resources;
  let view = bindings.view();
  const reportedDirty = consumeReportedRowDirty(resources, scratch, view);
  if (previous && (reuseReportedDirty || !reportedDirty)) {
    return previous.dirty || previous.y !== rowIndex
      ? { ...previous, y: rowIndex, dirty: false }
      : previous;
  }

  const rawResult = bindings.getRenderStateRowValueResult(
    rowIteratorHandle,
    GHOSTTY_RENDER_STATE_ROW_DATA_RAW,
    scratch.cellRaw
  );
  if (rawResult !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty u64 read failed with result ${rawResult}`);
  }
  const rawRow = view.getBigUint64(scratch.cellRaw, true);
  bindings.bindRenderStateRowCells(rowIteratorHandle, rowCellsHandle);

  const cells: GhosttyRenderCell[] = [];
  const changed = readRowCells(resources, scratch, previous?.cells ?? null, cells);
  view = bindings.view();

  const wrapResult = bindings.getRawRowValueResult(rawRow, GHOSTTY_ROW_DATA_WRAP, scratch.u8);
  if (wrapResult !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty bool read failed with result ${wrapResult}`);
  }
  const wrap = view.getUint8(scratch.u8) !== 0;
  const continuationResult = bindings.getRawRowValueResult(
    rawRow,
    GHOSTTY_ROW_DATA_WRAP_CONTINUATION,
    scratch.u8
  );
  if (continuationResult !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty bool read failed with result ${continuationResult}`);
  }
  const wrapContinuation = view.getUint8(scratch.u8) !== 0;

  const reused = changed
    ? null
    : reuseUnchangedRow(previous, rowIndex, cells.length, wrap, wrapContinuation);
  if (reused) {
    return reused;
  }
  return {
    y: rowIndex,
    dirty: reportedDirty || changed,
    wrap,
    wrapContinuation,
    text: buildRowText(cells),
    cells,
  };
}
