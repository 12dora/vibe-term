import type { GhosttyBindings } from './ghostty-wasm';
import type {
  GhosttyCellWidthKind,
  GhosttyColorRgb,
  GhosttyCursorVisualStyle,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderColors,
  GhosttyRenderCursor,
  GhosttyRenderDirtyState,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
} from './types';

const GHOSTTY_SUCCESS = 0;
const GHOSTTY_INVALID_VALUE = -2;

const GHOSTTY_RENDER_STATE_DATA_COLS = 1;
const GHOSTTY_RENDER_STATE_DATA_ROWS = 2;
const GHOSTTY_RENDER_STATE_DATA_DIRTY = 3;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE = 10;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE = 11;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING = 12;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_PASSWORD_INPUT = 13;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE = 14;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X = 15;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y = 16;
const GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL = 17;

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

// 共享不可变常量：绝大多数 cell 是空白或单个 ASCII 字符，复用这些实例把每 cell 的
// 数组/字符串分配降到 0（GhosttyRenderCell.codepoints 全链路只读）。
const EMPTY_CODEPOINTS: number[] = [];
const ASCII_TEXT: string[] = [];
const ASCII_CODEPOINTS: number[][] = [];
for (let codepoint = 0; codepoint < 128; codepoint += 1) {
  ASCII_TEXT.push(String.fromCharCode(codepoint));
  ASCII_CODEPOINTS.push([codepoint]);
}

// 内插表上限：正常终端里 style 组合与实际用色都是几十到几百量级，超出即认为
// 出现了病态输入，整表丢弃重建，避免 Map 无界增长。
const INTERN_LIMIT = 8192;
const GRAPHEME_SCRATCH_CODEPOINTS = 64;

// 每个 render state 一块常驻 WASM 暂存区：替代原先「每次读取 alloc/free 一次」的
// 模式（一对 alloc+free 约等于 3.5 次普通导出调用）。
type RenderStateScratch = {
  base: number;
  size: number;
  u64: number;
  u32: number;
  u8: number;
  style: number;
  color: number;
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

type GhosttyRenderStateResources = {
  bindings: GhosttyBindings;
  renderStateHandle: number;
  rowIteratorHandle: number;
  rowCellsHandle: number;
  snapshotVersion: number;
  disposed: boolean;
  cachedMeta: GhosttyRenderSnapshotMeta | null;
  metaVersion: number;
  scratch: RenderStateScratch | null;
  cachedColors: GhosttyRenderColors | null;
  colorsSnapshot: Uint8Array | null;
  colorsChanged: boolean;
  styleCache: Map<number, GhosttyRenderCellStyle>;
  colorCache: Map<number, GhosttyColorRgb>;
  previousRows: GhosttyRenderRow[] | null;
  previousCols: number;
  rowsVersion: number;
};

function ensureActive(resources: GhosttyRenderStateResources): void {
  if (resources.disposed || resources.renderStateHandle === 0) {
    throw new Error('render state resources already disposed');
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function ensureScratch(resources: GhosttyRenderStateResources): RenderStateScratch {
  const existing = resources.scratch;
  if (existing) {
    return existing;
  }

  const bindings = resources.bindings;
  const styleSize = bindings.typeSize('GhosttyStyle');
  const colorSize = bindings.typeSize('GhosttyColorRgb');
  const colorsSize = bindings.typeSize('GhosttyRenderStateColors');

  const styleOffset = 16;
  const colorOffset = alignUp(styleOffset + styleSize, 8);
  const colorsOffset = alignUp(colorOffset + colorSize, 8);
  const graphemesOffset = alignUp(colorsOffset + colorsSize, 8);
  const size = graphemesOffset + GRAPHEME_SCRATCH_CODEPOINTS * 4;

  // 多 8 字节用于把基址对齐到 8：u8 分配器不保证 u64 对齐。
  const raw = bindings.allocBytes(size + 8);
  const base = alignUp(raw, 8);

  const scratch: RenderStateScratch = {
    base: raw,
    size: size + 8,
    u64: base,
    u32: base + 8,
    u8: base + 12,
    style: base + styleOffset,
    color: base + colorOffset,
    colors: base + colorsOffset,
    graphemes: base + graphemesOffset,
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

  resources.scratch = scratch;
  return scratch;
}

function resultToDirtyState(value: number): GhosttyRenderDirtyState {
  switch (value) {
    case 2:
      return 'full';
    case 1:
      return 'partial';
    default:
      return 'clean';
  }
}

function resultToCursorStyle(value: number): GhosttyCursorVisualStyle {
  switch (value) {
    case 0:
      return 'bar';
    case 2:
      return 'underline';
    case 3:
      return 'block-hollow';
    default:
      return 'block';
  }
}

function resultToCellWidthKind(value: number): GhosttyCellWidthKind {
  switch (value) {
    case 1:
      return 'wide';
    case 2:
      return 'spacer-tail';
    case 3:
      return 'spacer-head';
    default:
      return 'narrow';
  }
}

function assertReadResult(result: unknown, what: string): void {
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty ${what} read failed with result ${result}`);
  }
}

// 颜色对象内插：同一 RGB 在整屏里成千上万次出现，按打包整数键复用同一实例，
// 让上层可以用引用相等做「这个 cell 变了吗」的判断。
function internColor(
  resources: GhosttyRenderStateResources,
  red: number,
  green: number,
  blue: number
): GhosttyColorRgb {
  const key = (red << 16) | (green << 8) | blue;
  const cached = resources.colorCache.get(key);
  if (cached) {
    return cached;
  }

  if (resources.colorCache.size >= INTERN_LIMIT) {
    resources.colorCache.clear();
  }

  const color: GhosttyColorRgb = { r: red, g: green, b: blue };
  resources.colorCache.set(key, color);
  return color;
}

function readColorAt(
  resources: GhosttyRenderStateResources,
  ptr: number,
  view: DataView
): GhosttyColorRgb {
  return internColor(resources, view.getUint8(ptr), view.getUint8(ptr + 1), view.getUint8(ptr + 2));
}

function readOptionalColor(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number
): GhosttyColorRgb | null {
  const scratch = ensureScratch(resources);
  const result = read(scratch.color);
  if (result === GHOSTTY_INVALID_VALUE) {
    return null;
  }

  if (result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty optional color read failed with result ${result}`);
  }

  return readColorAt(resources, scratch.color, resources.bindings.view());
}

function readBool(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): boolean {
  const scratch = ensureScratch(resources);
  assertReadResult(read(scratch.u8), 'bool');
  return resources.bindings.view().getUint8(scratch.u8) !== 0;
}

function readU16(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const scratch = ensureScratch(resources);
  assertReadResult(read(scratch.u32), 'u16');
  return resources.bindings.view().getUint16(scratch.u32, true);
}

function readU32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const scratch = ensureScratch(resources);
  assertReadResult(read(scratch.u32), 'u32');
  return resources.bindings.view().getUint32(scratch.u32, true);
}

function readEnumI32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): number {
  const scratch = ensureScratch(resources);
  assertReadResult(read(scratch.u32), 'enum');
  return resources.bindings.view().getInt32(scratch.u32, true);
}

function readU64(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number | void
): bigint {
  const scratch = ensureScratch(resources);
  assertReadResult(read(scratch.u64), 'u64');
  return resources.bindings.view().getBigUint64(scratch.u64, true);
}

// style 内插：把 8 个 bool + underline 打成整数键，整屏通常只有个位数到几十种组合。
function readStyle(resources: GhosttyRenderStateResources): GhosttyRenderCellStyle {
  const scratch = ensureScratch(resources);
  const bindings = resources.bindings;
  bindings.view().setUint32(scratch.style + scratch.styleSizeOffset, scratch.styleSize, true);
  bindings.getRenderStateRowCellValue(
    resources.rowCellsHandle,
    GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
    scratch.style
  );

  const view = bindings.view();
  const offsets = scratch.styleFlagOffsets;
  let flags = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    if (view.getUint8(scratch.style + offsets[index]) !== 0) {
      flags |= 1 << index;
    }
  }
  const underline = view.getInt32(scratch.style + scratch.styleUnderlineOffset, true);

  const key = underline * 256 + flags;
  const cached = resources.styleCache.get(key);
  if (cached) {
    return cached;
  }

  if (resources.styleCache.size >= INTERN_LIMIT) {
    resources.styleCache.clear();
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
  resources.styleCache.set(key, style);
  return style;
}

function readCodepointsInto(resources: GhosttyRenderStateResources, buffer: number[]): number {
  const graphemeLen = readU32(resources, (ptr) =>
    resources.bindings.getRenderStateRowCellValueResult(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
      ptr
    )
  );

  if (graphemeLen === 0) {
    return 0;
  }

  const scratch = ensureScratch(resources);
  const inline = graphemeLen <= GRAPHEME_SCRATCH_CODEPOINTS;
  const bufPtr = inline ? scratch.graphemes : resources.bindings.allocBytes(graphemeLen * 4);

  try {
    resources.bindings.getRenderStateRowCellValue(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
      bufPtr
    );

    const view = resources.bindings.view();
    for (let index = 0; index < graphemeLen; index += 1) {
      buffer[index] = view.getUint32(bufPtr + index * 4, true);
    }

    return graphemeLen;
  } finally {
    if (!inline) {
      resources.bindings.freeBytes(bufPtr, graphemeLen * 4);
    }
  }
}

function codepointsToText(buffer: number[], length: number): string {
  if (length === 0) {
    return '';
  }

  if (length === 1) {
    const codepoint = buffer[0];
    if (codepoint < 128) {
      return ASCII_TEXT[codepoint];
    }
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

type RenderStatePointerRead = (ptr: number) => number;

function stateValueReader(
  resources: GhosttyRenderStateResources,
  data: number
): RenderStatePointerRead {
  return (ptr: number) =>
    resources.bindings.getRenderStateValueResult(resources.renderStateHandle, data, ptr);
}

function readStateBool(resources: GhosttyRenderStateResources, data: number): boolean {
  return readBool(resources, stateValueReader(resources, data));
}

function readStateU16(resources: GhosttyRenderStateResources, data: number): number {
  return readU16(resources, stateValueReader(resources, data));
}

function readStateEnum(resources: GhosttyRenderStateResources, data: number): number {
  return readEnumI32(resources, stateValueReader(resources, data));
}

function readOptionalStateU16(
  resources: GhosttyRenderStateResources,
  data: number,
  present: boolean
): number | null {
  return present ? readStateU16(resources, data) : null;
}

// 调色板/前后景/光标色整体只在主题切换、OSC 改色时变化，但 WASM 侧没有版本号可读。
// 用「把 colors 结构体读进常驻暂存区后按字节比对」当变更信号：每帧一次导出调用 +
// 一次约 800 字节的 memcmp，换掉每帧 256 个 palette 对象的重建。
function readColors(resources: GhosttyRenderStateResources): GhosttyRenderColors {
  const scratch = ensureScratch(resources);
  const bindings = resources.bindings;

  bindings.setField(
    bindings.view(scratch.colors, scratch.colorsSize),
    'GhosttyRenderStateColors',
    'size',
    scratch.colorsSize
  );
  bindings.getRenderStateColors(resources.renderStateHandle, scratch.colors);

  const raw = bindings.bytes(scratch.colors, scratch.colorsSize);
  const snapshot = resources.colorsSnapshot;
  let changed = snapshot === null || snapshot.length !== scratch.colorsSize;
  if (snapshot && !changed) {
    for (let index = 0; index < snapshot.length; index += 1) {
      if (snapshot[index] !== raw[index]) {
        changed = true;
        break;
      }
    }
  }

  resources.colorsChanged = changed;
  const cached = resources.cachedColors;
  if (!changed && cached) {
    return cached;
  }

  const target =
    snapshot && snapshot.length === scratch.colorsSize
      ? snapshot
      : new Uint8Array(scratch.colorsSize);
  target.set(raw);
  resources.colorsSnapshot = target;

  const view = bindings.view();
  const palette: GhosttyColorRgb[] = [];
  for (let index = 0; index < 256; index += 1) {
    palette.push(
      readColorAt(resources, scratch.colors + scratch.colorsPaletteOffset + index * 3, view)
    );
  }

  const colors: GhosttyRenderColors = {
    background: readColorAt(resources, scratch.colors + scratch.colorsBackgroundOffset, view),
    foreground: readColorAt(resources, scratch.colors + scratch.colorsForegroundOffset, view),
    cursor:
      view.getUint8(scratch.colors + scratch.colorsCursorHasValueOffset) !== 0
        ? readColorAt(resources, scratch.colors + scratch.colorsCursorOffset, view)
        : null,
    palette,
  };
  resources.cachedColors = colors;
  return colors;
}

function readViewportMeta(
  resources: GhosttyRenderStateResources
): Pick<GhosttyRenderSnapshotMeta, 'cols' | 'rows' | 'dirty'> {
  return {
    cols: readStateU16(resources, GHOSTTY_RENDER_STATE_DATA_COLS),
    rows: readStateU16(resources, GHOSTTY_RENDER_STATE_DATA_ROWS),
    dirty: resultToDirtyState(readStateEnum(resources, GHOSTTY_RENDER_STATE_DATA_DIRTY)),
  };
}

function readCursorMeta(
  resources: GhosttyRenderStateResources,
  viewportHasValue: boolean
): GhosttyRenderCursor {
  return {
    style: resultToCursorStyle(
      readStateEnum(resources, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE)
    ),
    visible: readStateBool(resources, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE),
    blinking: readStateBool(resources, GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING),
    passwordInput: readStateBool(resources, GHOSTTY_RENDER_STATE_DATA_CURSOR_PASSWORD_INPUT),
    x: readOptionalStateU16(
      resources,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
      viewportHasValue
    ),
    y: readOptionalStateU16(
      resources,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
      viewportHasValue
    ),
    wideTail: viewportHasValue
      ? readStateBool(resources, GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL)
      : false,
  };
}

function readMeta(resources: GhosttyRenderStateResources): GhosttyRenderSnapshotMeta {
  const colors = readColors(resources);
  const cursorViewportHasValue = readStateBool(
    resources,
    GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE
  );
  const viewport = readViewportMeta(resources);

  return {
    cols: viewport.cols,
    rows: viewport.rows,
    dirty: viewport.dirty,
    colors,
    cursor: readCursorMeta(resources, cursorViewportHasValue),
  };
}

const graphemeScratch: number[] = new Array(GRAPHEME_SCRATCH_CODEPOINTS).fill(0);

// 逐 cell 先读原始值再和上一帧同位置比对：style / 颜色都是内插实例，比对退化成引用相等。
// 内容未变时直接复用上一帧的 cell 对象（不新建），整行未变时复用整行（含 text）。
function readRow(
  resources: GhosttyRenderStateResources,
  rowIndex: number,
  previous: GhosttyRenderRow | null
): GhosttyRenderRow {
  const bindings = resources.bindings;
  const rawRow = readU64(resources, (ptr) =>
    bindings.getRenderStateRowValueResult(
      resources.rowIteratorHandle,
      GHOSTTY_RENDER_STATE_ROW_DATA_RAW,
      ptr
    )
  );
  bindings.bindRenderStateRowCells(resources.rowIteratorHandle, resources.rowCellsHandle);

  const previousCells = previous?.cells ?? null;
  const cells: GhosttyRenderCell[] = [];
  let changed = false;
  let x = 0;

  while (bindings.nextRenderStateRowCell(resources.rowCellsHandle)) {
    const rawCell = readU64(resources, (ptr) =>
      bindings.getRenderStateRowCellValueResult(
        resources.rowCellsHandle,
        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
        ptr
      )
    );
    const codepointCount = readCodepointsInto(resources, graphemeScratch);
    const widthKind = resultToCellWidthKind(
      readEnumI32(resources, (ptr) =>
        bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_WIDE, ptr)
      )
    );
    const hasText = readBool(resources, (ptr) =>
      bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_HAS_TEXT, ptr)
    );
    const style = readStyle(resources);
    const fgColor = readOptionalColor(resources, (ptr) =>
      bindings.getRenderStateRowCellValueResult(
        resources.rowCellsHandle,
        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
        ptr
      )
    );
    const bgColor = readOptionalColor(resources, (ptr) =>
      bindings.getRenderStateRowCellValueResult(
        resources.rowCellsHandle,
        GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
        ptr
      )
    );

    const text = codepointsToText(graphemeScratch, codepointCount);
    const reusable = previousCells ? previousCells[x] : undefined;
    if (
      reusable &&
      reusable.text === text &&
      reusable.codepoints.length === codepointCount &&
      reusable.widthKind === widthKind &&
      reusable.hasText === hasText &&
      reusable.style === style &&
      reusable.fgColor === fgColor &&
      reusable.bgColor === bgColor
    ) {
      cells.push(reusable);
      x += 1;
      continue;
    }

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
    x += 1;
  }

  const wrap = readBool(resources, (ptr) =>
    bindings.getRawRowValueResult(rawRow, GHOSTTY_ROW_DATA_WRAP, ptr)
  );
  const wrapContinuation = readBool(resources, (ptr) =>
    bindings.getRawRowValueResult(rawRow, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, ptr)
  );
  // WASM 侧的行 dirty 位在当前 ghostty 构建里恒为 true（见 bench 报告），只作为
  // 「必须重画」的下限；真正的重画判据是上面的逐 cell 比对。
  const reportedDirty = readBool(resources, (ptr) =>
    bindings.getRenderStateRowValueResult(
      resources.rowIteratorHandle,
      GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
      ptr
    )
  );

  if (
    previous &&
    !changed &&
    previous.cells.length === cells.length &&
    previous.wrap === wrap &&
    previous.wrapContinuation === wrapContinuation
  ) {
    return previous.dirty
      ? {
          y: rowIndex,
          dirty: false,
          wrap,
          wrapContinuation,
          text: previous.text,
          cells: previous.cells,
        }
      : previous;
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

export function createRenderState(bindings: GhosttyBindings): GhosttyRenderStateResources {
  let renderStateHandle = 0;
  let rowIteratorHandle = 0;
  let rowCellsHandle = 0;

  try {
    renderStateHandle = bindings.createRenderState();
    rowIteratorHandle = bindings.createRenderStateRowIterator();
    rowCellsHandle = bindings.createRenderStateRowCells();
  } catch (error) {
    if (rowCellsHandle !== 0) {
      bindings.freeRenderStateRowCells(rowCellsHandle);
    }
    if (rowIteratorHandle !== 0) {
      bindings.freeRenderStateRowIterator(rowIteratorHandle);
    }
    if (renderStateHandle !== 0) {
      bindings.freeRenderState(renderStateHandle);
    }
    throw error;
  }

  return {
    bindings,
    renderStateHandle,
    rowIteratorHandle,
    rowCellsHandle,
    snapshotVersion: 0,
    disposed: false,
    cachedMeta: null,
    metaVersion: -1,
    scratch: null,
    cachedColors: null,
    colorsSnapshot: null,
    colorsChanged: true,
    styleCache: new Map(),
    colorCache: new Map(),
    previousRows: null,
    previousCols: -1,
    rowsVersion: -1,
  };
}

export function updateRenderState(
  resources: GhosttyRenderStateResources,
  terminalHandle: number
): void {
  ensureActive(resources);
  resources.bindings.updateRenderState(resources.renderStateHandle, terminalHandle);
  resources.bindings.bindRenderStateRowIterator(
    resources.renderStateHandle,
    resources.rowIteratorHandle
  );
  resources.snapshotVersion += 1;
}

export function readRenderSnapshotMeta(
  resources: GhosttyRenderStateResources
): GhosttyRenderSnapshotMeta {
  ensureActive(resources);
  if (!resources.cachedMeta || resources.metaVersion !== resources.snapshotVersion) {
    resources.cachedMeta = readMeta(resources);
    resources.metaVersion = resources.snapshotVersion;
  }

  return resources.cachedMeta;
}

export function* iterateRows(
  resources: GhosttyRenderStateResources
): Generator<GhosttyRenderRow, void, undefined> {
  ensureActive(resources);
  const meta = readRenderSnapshotMeta(resources);

  const settled = resources.previousRows;
  if (settled && resources.rowsVersion === resources.snapshotVersion) {
    yield* settled;
    return;
  }

  // 上一帧完整覆盖同样几何、且配色未变，才允许把 WASM 的 dirty='full' 降级为按行重画。
  const comparable =
    settled !== null &&
    settled.length === meta.rows &&
    resources.previousCols === meta.cols &&
    !resources.colorsChanged;

  resources.bindings.bindRenderStateRowIterator(
    resources.renderStateHandle,
    resources.rowIteratorHandle
  );

  const rows: GhosttyRenderRow[] = [];
  let rowIndex = 0;
  while (
    rowIndex < meta.rows &&
    resources.bindings.nextRenderStateRowIterator(resources.rowIteratorHandle)
  ) {
    const row = readRow(resources, rowIndex, comparable && settled ? settled[rowIndex] : null);
    rows.push(row);
    yield row;
    rowIndex += 1;
  }

  // 迭代被中途打断时不更新缓存，也不降级 dirty：保持「全画」这个安全下限。
  if (rowIndex !== meta.rows) {
    return;
  }

  resources.previousRows = rows;
  resources.previousCols = meta.cols;
  resources.rowsVersion = resources.snapshotVersion;

  if (comparable && meta.dirty === 'full') {
    const changedRows = rows.reduce((count, row) => count + (row.dirty ? 1 : 0), 0);
    if (changedRows === 0) {
      meta.dirty = 'clean';
    } else if (changedRows < rows.length) {
      meta.dirty = 'partial';
    }
  }
}

export function disposeRenderStateResources(resources: GhosttyRenderStateResources): void {
  if (resources.disposed) {
    return;
  }

  resources.disposed = true;
  if (resources.scratch) {
    resources.bindings.freeBytes(resources.scratch.base, resources.scratch.size);
    resources.scratch = null;
  }
  if (resources.rowCellsHandle !== 0) {
    resources.bindings.freeRenderStateRowCells(resources.rowCellsHandle);
    resources.rowCellsHandle = 0;
  }
  if (resources.rowIteratorHandle !== 0) {
    resources.bindings.freeRenderStateRowIterator(resources.rowIteratorHandle);
    resources.rowIteratorHandle = 0;
  }
  if (resources.renderStateHandle !== 0) {
    resources.bindings.freeRenderState(resources.renderStateHandle);
    resources.renderStateHandle = 0;
  }
  resources.cachedMeta = null;
  resources.cachedColors = null;
  resources.colorsSnapshot = null;
  resources.previousRows = null;
  resources.styleCache.clear();
  resources.colorCache.clear();
}

export type { GhosttyRenderStateResources };
