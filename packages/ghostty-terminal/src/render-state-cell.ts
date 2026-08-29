import {
  type GhosttyRenderStateResources,
  readBool,
  readEnumI32,
  readOptionalColor,
  readU32,
  readU64,
} from './render-state-reads';
import type {
  GhosttyCellWidthKind,
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
} from './types';

const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW = 1;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE = 2;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN = 3;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF = 4;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR = 5;
const GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR = 6;

const GHOSTTY_CELL_DATA_WIDE = 3;
const GHOSTTY_CELL_DATA_HAS_TEXT = 4;

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

function readStyle(resources: GhosttyRenderStateResources): GhosttyRenderCellStyle {
  const style = resources.bindings.allocStruct('GhosttyStyle');

  try {
    resources.bindings.setField(
      style.view,
      'GhosttyStyle',
      'size',
      resources.bindings.typeSize('GhosttyStyle')
    );
    resources.bindings.getRenderStateRowCellValue(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
      style.ptr
    );

    const field = (name: string) => resources.bindings.field('GhosttyStyle', name).offset;
    return {
      bold: style.view.getUint8(field('bold')) !== 0,
      italic: style.view.getUint8(field('italic')) !== 0,
      faint: style.view.getUint8(field('faint')) !== 0,
      blink: style.view.getUint8(field('blink')) !== 0,
      inverse: style.view.getUint8(field('inverse')) !== 0,
      invisible: style.view.getUint8(field('invisible')) !== 0,
      strikethrough: style.view.getUint8(field('strikethrough')) !== 0,
      overline: style.view.getUint8(field('overline')) !== 0,
      underline: style.view.getInt32(field('underline'), true),
    };
  } finally {
    style.free();
  }
}

function readCodepoints(resources: GhosttyRenderStateResources): number[] {
  const graphemeLen = readU32(resources, (ptr) =>
    resources.bindings.getRenderStateRowCellValueResult(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
      ptr
    )
  );

  if (graphemeLen === 0) {
    return [];
  }

  const bufPtr = resources.bindings.allocBytes(graphemeLen * 4);

  try {
    resources.bindings.getRenderStateRowCellValue(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
      bufPtr
    );

    const codepoints: number[] = [];
    for (let index = 0; index < graphemeLen; index += 1) {
      codepoints.push(resources.bindings.view().getUint32(bufPtr + index * 4, true));
    }

    return codepoints;
  } finally {
    resources.bindings.freeBytes(bufPtr, graphemeLen * 4);
  }
}

function codepointsToText(codepoints: number[]): string {
  if (codepoints.length === 0) {
    return '';
  }

  try {
    return String.fromCodePoint(...codepoints);
  } catch {
    return '';
  }
}

function readCellColor(
  resources: GhosttyRenderStateResources,
  data: number
): GhosttyColorRgb | null {
  return readOptionalColor(resources, (ptr) =>
    resources.bindings.getRenderStateRowCellValueResult(resources.rowCellsHandle, data, ptr)
  );
}

export function decodeRenderCell(
  resources: GhosttyRenderStateResources,
  x: number
): GhosttyRenderCell {
  const rawCell = readU64(resources, (ptr) =>
    resources.bindings.getRenderStateRowCellValueResult(
      resources.rowCellsHandle,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
      ptr
    )
  );
  const codepoints = readCodepoints(resources);
  const widthKind = resultToCellWidthKind(
    readEnumI32(resources, (ptr) =>
      resources.bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_WIDE, ptr)
    )
  );

  return {
    x,
    text: codepointsToText(codepoints),
    codepoints,
    widthKind,
    hasText: readBool(resources, (ptr) =>
      resources.bindings.getRawCellValueResult(rawCell, GHOSTTY_CELL_DATA_HAS_TEXT, ptr)
    ),
    style: readStyle(resources),
    fgColor: readCellColor(resources, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR),
    bgColor: readCellColor(resources, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR),
  };
}
