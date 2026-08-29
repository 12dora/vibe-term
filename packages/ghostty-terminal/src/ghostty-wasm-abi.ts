export const GHOSTTY_SUCCESS = 0;

export const GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND = 11;
export const GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND = 12;
export const GHOSTTY_TERMINAL_OPT_COLOR_CURSOR = 13;
export const GHOSTTY_TERMINAL_OPT_COLOR_PALETTE = 14;

export const GHOSTTY_TERMINAL_DATA_COLS = 1;
export const GHOSTTY_TERMINAL_DATA_ROWS = 2;
export const GHOSTTY_TERMINAL_DATA_SCROLLBAR = 9;
export const GHOSTTY_POINT_TAG_VIEWPORT = 1;

export const GHOSTTY_SCROLL_VIEWPORT_TOP = 0;
export const GHOSTTY_SCROLL_VIEWPORT_BOTTOM = 1;
export const GHOSTTY_SCROLL_VIEWPORT_DELTA = 2;

export const GHOSTTY_KEY_ACTION_RELEASE = 0;
export const GHOSTTY_KEY_ACTION_PRESS = 1;
export const GHOSTTY_KEY_ACTION_REPEAT = 2;

export const GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL = 4;

export const GHOSTTY_MODE_BRACKETED_PASTE = 2004;
export const GHOSTTY_MODE_X10_MOUSE = 9;
export const GHOSTTY_MODE_NORMAL_MOUSE = 1000;
export const GHOSTTY_MODE_BUTTON_MOUSE = 1002;
export const GHOSTTY_MODE_ANY_MOUSE = 1003;
export const GHOSTTY_MODE_UTF8_MOUSE = 1005;
export const GHOSTTY_MODE_SGR_MOUSE = 1006;
export const GHOSTTY_MODE_URXVT_MOUSE = 1015;
export const GHOSTTY_MODE_SGR_PIXELS_MOUSE = 1016;

export const GHOSTTY_FORMATTER_FORMAT_PLAIN = 0;
export const GHOSTTY_FORMATTER_FORMAT_HTML = 2;
export const WASM_USIZE_BYTES = 4;

export type LayoutField = {
  offset: number;
  size: number;
  type: string;
};

export type LayoutType = {
  size: number;
  align: number;
  fields: Record<string, LayoutField>;
};

export type LayoutMap = Record<string, LayoutType>;

export type GhosttyExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  ghostty_type_json: () => number;
  ghostty_alloc: (allocatorPtr: number, size: number, alignment: number) => number;
  ghostty_free: (allocatorPtr: number, ptr: number, len: number) => void;
  ghostty_wasm_alloc_opaque: () => number;
  ghostty_wasm_free_opaque: (ptr: number) => void;
  ghostty_wasm_alloc_u8: () => number;
  ghostty_wasm_free_u8: (ptr: number) => void;
  ghostty_wasm_alloc_u8_array: (len: number) => number;
  ghostty_wasm_free_u8_array: (ptr: number, len: number) => void;
  ghostty_wasm_alloc_usize: () => number;
  ghostty_wasm_free_usize: (ptr: number) => void;
  ghostty_terminal_new: (
    allocatorPtr: number,
    outTerminalPtr: number,
    optionsPtr: number
  ) => number;
  ghostty_terminal_free: (terminal: number) => void;
  ghostty_terminal_reset: (terminal: number) => void;
  ghostty_terminal_resize: (
    terminal: number,
    cols: number,
    rows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ) => number;
  ghostty_terminal_vt_write: (terminal: number, dataPtr: number, len: number) => void;
  ghostty_terminal_scroll_viewport: (terminal: number, behaviorPtr: number) => void;
  ghostty_terminal_set: (terminal: number, option: number, valuePtr: number) => number;
  ghostty_terminal_get: (terminal: number, data: number, outPtr: number) => number;
  ghostty_terminal_mode_get: (terminal: number, mode: number, outValuePtr: number) => number;
  ghostty_terminal_mode_set: (terminal: number, mode: number, enabled: number) => number;
  ghostty_terminal_grid_ref: (terminal: number, pointPtr: number, outRefPtr: number) => number;
  ghostty_render_state_new: (allocatorPtr: number, outStatePtr: number) => number;
  ghostty_render_state_free: (state: number) => void;
  ghostty_render_state_update: (state: number, terminal: number) => number;
  ghostty_render_state_get: (state: number, data: number, outPtr: number) => number;
  ghostty_render_state_set: (state: number, option: number, valuePtr: number) => number;
  ghostty_render_state_colors_get: (state: number, outColorsPtr: number) => number;
  ghostty_render_state_row_iterator_new: (allocatorPtr: number, outIteratorPtr: number) => number;
  ghostty_render_state_row_iterator_free: (iterator: number) => void;
  ghostty_render_state_row_iterator_next: (iterator: number) => number;
  ghostty_render_state_row_get: (iterator: number, data: number, outPtr: number) => number;
  ghostty_render_state_row_set: (iterator: number, option: number, valuePtr: number) => number;
  ghostty_render_state_row_cells_new: (allocatorPtr: number, outCellsPtr: number) => number;
  ghostty_render_state_row_cells_free: (cells: number) => void;
  ghostty_render_state_row_cells_next: (cells: number) => number;
  ghostty_render_state_row_cells_select: (cells: number, x: number) => number;
  ghostty_render_state_row_cells_get: (cells: number, data: number, outPtr: number) => number;
  ghostty_row_get: (row: bigint, data: number, outPtr: number) => number;
  ghostty_cell_get: (cell: bigint, data: number, outPtr: number) => number;
  ghostty_formatter_terminal_new: (
    allocatorPtr: number,
    outFormatterPtr: number,
    terminal: number,
    optionsPtr: number
  ) => number;
  ghostty_formatter_format_alloc: (
    formatter: number,
    allocatorPtr: number,
    outPtrPtr: number,
    outLenPtr: number
  ) => number;
  ghostty_formatter_free: (formatter: number) => void;
  ghostty_key_encoder_new: (allocatorPtr: number, outEncoderPtr: number) => number;
  ghostty_key_encoder_free: (encoder: number) => void;
  ghostty_key_encoder_setopt_from_terminal: (encoder: number, terminal: number) => void;
  ghostty_mouse_encoder_new: (allocatorPtr: number, outEncoderPtr: number) => number;
  ghostty_mouse_encoder_free: (encoder: number) => void;
  ghostty_mouse_encoder_reset: (encoder: number) => void;
  ghostty_mouse_encoder_setopt: (encoder: number, option: number, valuePtr: number) => void;
  ghostty_mouse_encoder_setopt_from_terminal: (encoder: number, terminal: number) => void;
  ghostty_mouse_encoder_encode: (
    encoder: number,
    event: number,
    outBufPtr: number,
    outBufLen: number,
    outWrittenPtr: number
  ) => number;
  ghostty_mouse_event_new: (allocatorPtr: number, outEventPtr: number) => number;
  ghostty_mouse_event_free: (event: number) => void;
  ghostty_mouse_event_set_action: (event: number, action: number) => void;
  ghostty_mouse_event_set_button: (event: number, button: number) => void;
  ghostty_mouse_event_clear_button: (event: number) => void;
  ghostty_mouse_event_set_mods: (event: number, mods: number) => void;
  ghostty_mouse_event_set_position: (event: number, positionPtr: number) => void;
  ghostty_key_event_new: (allocatorPtr: number, outEventPtr: number) => number;
  ghostty_key_event_free: (event: number) => void;
  ghostty_key_event_set_action: (event: number, action: number) => void;
  ghostty_key_event_set_key: (event: number, key: number) => void;
  ghostty_key_event_set_mods: (event: number, mods: number) => void;
  ghostty_key_event_set_consumed_mods: (event: number, consumedMods: number) => void;
  ghostty_key_event_set_composing: (event: number, composing: number) => void;
  ghostty_key_event_set_utf8: (event: number, utf8Ptr: number, len: number) => void;
  ghostty_key_event_set_unshifted_codepoint: (event: number, codepoint: number) => void;
  ghostty_key_encoder_encode: (
    encoder: number,
    event: number,
    outBufPtr: number,
    outBufLen: number,
    outWrittenPtr: number
  ) => number;
  ghostty_paste_encode: (
    dataPtr: number,
    dataLen: number,
    bracketed: number,
    outBufPtr: number,
    outBufLen: number,
    outWrittenPtr: number
  ) => number;
};

export function assertResult(result: number, action: string): void {
  if (result === GHOSTTY_SUCCESS) {
    return;
  }

  throw new Error(`${action} failed with result ${result}`);
}
