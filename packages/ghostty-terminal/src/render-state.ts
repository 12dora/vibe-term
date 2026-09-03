import type { GhosttyBindings } from './ghostty-wasm';
import { readColorAt } from './render-state-color';
import {
  type RenderStateScratch,
  ensureRenderStateScratch,
  readRenderStateRow,
  releaseRenderStateScratch,
} from './render-state-read';
import {
  applyShiftDirtyDowngrade,
  lookupShiftedPreviousRow,
  resolveShiftBaseline,
} from './render-state-shift';
import type {
  GhosttyColorRgb,
  GhosttyCursorVisualStyle,
  GhosttyRenderCellStyle,
  GhosttyRenderColors,
  GhosttyRenderCursor,
  GhosttyRenderDirtyState,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
} from './types';

const GHOSTTY_SUCCESS = 0;

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
  appliedScrollDelta: number;
};

function ensureActive(resources: GhosttyRenderStateResources): void {
  if (resources.disposed || resources.renderStateHandle === 0) {
    throw new Error('render state resources already disposed');
  }
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

function assertReadResult(result: unknown, what: string): void {
  if (typeof result === 'number' && result !== GHOSTTY_SUCCESS) {
    throw new Error(`ghostty ${what} read failed with result ${result}`);
  }
}

function readBool(resources: GhosttyRenderStateResources, read: (ptr: number) => number): boolean {
  const scratch = ensureRenderStateScratch(resources);
  assertReadResult(read(scratch.u8), 'bool');
  return resources.bindings.view().getUint8(scratch.u8) !== 0;
}

function readU16(resources: GhosttyRenderStateResources, read: (ptr: number) => number): number {
  const scratch = ensureRenderStateScratch(resources);
  assertReadResult(read(scratch.u32), 'u16');
  return resources.bindings.view().getUint16(scratch.u32, true);
}

function readEnumI32(
  resources: GhosttyRenderStateResources,
  read: (ptr: number) => number
): number {
  const scratch = ensureRenderStateScratch(resources);
  assertReadResult(read(scratch.u32), 'enum');
  return resources.bindings.view().getInt32(scratch.u32, true);
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
  const scratch = ensureRenderStateScratch(resources);
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
      readColorAt(
        resources.colorCache,
        scratch.colors + scratch.colorsPaletteOffset + index * 3,
        view
      )
    );
  }

  const colors: GhosttyRenderColors = {
    background: readColorAt(
      resources.colorCache,
      scratch.colors + scratch.colorsBackgroundOffset,
      view
    ),
    foreground: readColorAt(
      resources.colorCache,
      scratch.colors + scratch.colorsForegroundOffset,
      view
    ),
    cursor:
      view.getUint8(scratch.colors + scratch.colorsCursorHasValueOffset) !== 0
        ? readColorAt(resources.colorCache, scratch.colors + scratch.colorsCursorOffset, view)
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
    appliedScrollDelta: 0,
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
  resources: GhosttyRenderStateResources,
  scrollDelta = 0
): Generator<GhosttyRenderRow, void, undefined> {
  ensureActive(resources);
  const meta = readRenderSnapshotMeta(resources);
  resources.appliedScrollDelta = 0;

  const settled = resources.previousRows;
  if (settled && resources.rowsVersion === resources.snapshotVersion) {
    yield* settled;
    return;
  }

  const { comparable, shifted } = resolveShiftBaseline(
    settled,
    meta,
    resources.previousCols,
    resources.colorsChanged,
    scrollDelta
  );

  resources.bindings.bindRenderStateRowIterator(
    resources.renderStateHandle,
    resources.rowIteratorHandle
  );

  const rows: GhosttyRenderRow[] = [];
  // dirty 位在迭代中逐行被消费，生成器一旦被中途丢弃这一帧就不能再当基线：
  // 先作废缓存，走完整轮才写回。
  resources.previousRows = null;
  let rowIndex = 0;
  while (
    rowIndex < meta.rows &&
    resources.bindings.nextRenderStateRowIterator(resources.rowIteratorHandle)
  ) {
    const previous = lookupShiftedPreviousRow(comparable, settled, rowIndex, shifted);
    const row = readRenderStateRow(
      resources,
      rowIndex,
      previous,
      shifted !== 0 && previous !== null
    );
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
  resources.appliedScrollDelta = shifted;
  applyShiftDirtyDowngrade(meta, comparable, shifted, rows);
}

export function disposeRenderStateResources(resources: GhosttyRenderStateResources): void {
  if (resources.disposed) {
    return;
  }

  resources.disposed = true;
  releaseRenderStateScratch(resources);
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
export { isCellUnchanged, reuseUnchangedRow } from './render-state-read';
