export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_CELL_WIDTH = 9;
export const DEFAULT_CELL_HEIGHT = 17;
// 行高倍率默认值（cell 高 = fontSize × lineHeight）。CSS/probe/textarea/cell 计算共用同一来源，
// 避免散落的 '1.2' 漂移。可由 init options.lineHeight 覆盖；cell 高由此唯一确定，不依赖 DOM 测量。
export const LINE_HEIGHT = 1.2;

export const GHOSTTY_MODE_X10_MOUSE = 9;
export const GHOSTTY_MODE_NORMAL_MOUSE = 1000;
export const GHOSTTY_MODE_BUTTON_MOUSE = 1002;
export const GHOSTTY_MODE_ANY_MOUSE = 1003;
export const GHOSTTY_MODE_UTF8_MOUSE = 1005;
export const GHOSTTY_MODE_SGR_MOUSE = 1006;
export const GHOSTTY_MODE_URXVT_MOUSE = 1015;
export const GHOSTTY_MODE_SGR_PIXELS_MOUSE = 1016;
export const GHOSTTY_MODE_ALT_SCROLL = 1007;
export const GHOSTTY_MODE_ALT_SCREEN = 1047;
export const GHOSTTY_MODE_ALT_SCREEN_SAVE = 1049;
export const GHOSTTY_MODE_SYNCHRONIZED_OUTPUT = 2026;

export const MOUSE_TRACKING_MODES: readonly number[] = [
  GHOSTTY_MODE_X10_MOUSE,
  GHOSTTY_MODE_NORMAL_MOUSE,
  GHOSTTY_MODE_BUTTON_MOUSE,
  GHOSTTY_MODE_ANY_MOUSE,
];
