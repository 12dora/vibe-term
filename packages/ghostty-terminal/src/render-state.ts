import type { GhosttyBindings } from './ghostty-wasm';
import { decodeRenderCell } from './render-state-cell';
import {
  type GhosttyRenderStateResources,
  type RenderStateRead,
  readBool,
  readColorAt,
  readEnumI32,
  readU16,
  readU64,
} from './render-state-reads';
import type {
  GhosttyColorRgb,
  GhosttyCursorVisualStyle,
  GhosttyRenderCell,
  GhosttyRenderColors,
  GhosttyRenderCursor,
  GhosttyRenderDirtyState,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
} from './types';

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

const GHOSTTY_ROW_DATA_WRAP = 1;
const GHOSTTY_ROW_DATA_WRAP_CONTINUATION = 2;

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

function stateValueReader(resources: GhosttyRenderStateResources, data: number): RenderStateRead {
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

function readColors(resources: GhosttyRenderStateResources): GhosttyRenderColors {
  const colors = resources.bindings.allocStruct('GhosttyRenderStateColors');

  try {
    resources.bindings.setField(
      colors.view,
      'GhosttyRenderStateColors',
      'size',
      resources.bindings.typeSize('GhosttyRenderStateColors')
    );
    resources.bindings.getRenderStateColors(resources.renderStateHandle, colors.ptr);

    const fieldOffset = (name: string) =>
      resources.bindings.field('GhosttyRenderStateColors', name).offset;

    const paletteOffset = fieldOffset('palette');
    const palette: GhosttyColorRgb[] = [];
    for (let index = 0; index < 256; index += 1) {
      palette.push(readColorAt(resources.bindings, colors.ptr + paletteOffset + index * 3));
    }

    const cursorHasValue = colors.view.getUint8(fieldOffset('cursor_has_value')) !== 0;

    return {
      background: readColorAt(resources.bindings, colors.ptr + fieldOffset('background')),
      foreground: readColorAt(resources.bindings, colors.ptr + fieldOffset('foreground')),
      cursor: cursorHasValue
        ? readColorAt(resources.bindings, colors.ptr + fieldOffset('cursor'))
        : null,
      palette,
    };
  } finally {
    colors.free();
  }
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

function rowValueReader(resources: GhosttyRenderStateResources, data: number): RenderStateRead {
  return (ptr: number) =>
    resources.bindings.getRenderStateRowValueResult(resources.rowIteratorHandle, data, ptr);
}

function rawRowValueReader(
  resources: GhosttyRenderStateResources,
  rawRow: bigint,
  data: number
): RenderStateRead {
  return (ptr: number) => resources.bindings.getRawRowValueResult(rawRow, data, ptr);
}

function readRow(resources: GhosttyRenderStateResources, rowIndex: number): GhosttyRenderRow {
  const rawRow = readU64(resources, rowValueReader(resources, GHOSTTY_RENDER_STATE_ROW_DATA_RAW));
  resources.bindings.bindRenderStateRowCells(resources.rowIteratorHandle, resources.rowCellsHandle);

  const cells: GhosttyRenderCell[] = [];
  while (resources.bindings.nextRenderStateRowCell(resources.rowCellsHandle)) {
    cells.push(decodeRenderCell(resources, cells.length));
  }

  return {
    y: rowIndex,
    dirty: readBool(resources, rowValueReader(resources, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY)),
    wrap: readBool(resources, rawRowValueReader(resources, rawRow, GHOSTTY_ROW_DATA_WRAP)),
    wrapContinuation: readBool(
      resources,
      rawRowValueReader(resources, rawRow, GHOSTTY_ROW_DATA_WRAP_CONTINUATION)
    ),
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
  resources.cachedMeta = null;
}

export function readRenderSnapshotMeta(
  resources: GhosttyRenderStateResources
): GhosttyRenderSnapshotMeta {
  ensureActive(resources);
  if (!resources.cachedMeta) {
    resources.cachedMeta = readMeta(resources);
  }

  return resources.cachedMeta;
}

export function* iterateRows(
  resources: GhosttyRenderStateResources
): Generator<GhosttyRenderRow, void, undefined> {
  ensureActive(resources);
  const meta = readRenderSnapshotMeta(resources);
  resources.bindings.bindRenderStateRowIterator(
    resources.renderStateHandle,
    resources.rowIteratorHandle
  );

  let rowIndex = 0;
  while (
    rowIndex < meta.rows &&
    resources.bindings.nextRenderStateRowIterator(resources.rowIteratorHandle)
  ) {
    yield readRow(resources, rowIndex);
    rowIndex += 1;
  }
}

export function disposeRenderStateResources(resources: GhosttyRenderStateResources): void {
  if (resources.disposed) {
    return;
  }

  resources.disposed = true;
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
}

export type { GhosttyRenderStateResources };
