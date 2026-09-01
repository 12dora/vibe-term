export interface GhosttyTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface GhosttyTerminalInitOptions {
  theme: GhosttyTheme;
  fontFamily: string;
  fontSize: number;
  /** 行高倍率（cell 高 = fontSize × lineHeight）。缺省走内置默认 1.2。 */
  lineHeight?: number;
  scrollback: number;
  disableStdin?: boolean;
}

export interface GhosttyTerminalSize {
  cols: number;
  rows: number;
}

export interface GhosttyCellDimensions {
  width: number;
  height: number;
}

/** 平移视口（follower 模式）的可滚状态。overflow* = 0 表示该轴不超尺寸。 */
export interface GhosttyPanMetrics {
  scrollLeft: number;
  scrollTop: number;
  overflowX: number;
  overflowY: number;
}

/** panBy 真正落地的位移（已夹取到可滚范围内）。 */
export interface GhosttyPanDelta {
  deltaX: number;
  deltaY: number;
}

export interface GhosttyViewportGesture {
  source: 'wheel' | 'touch';
  deltaX?: number;
  deltaY: number;
  deltaMode?: number;
  clientX: number;
  clientY: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export interface GhosttyTerminalModeSnapshot {
  mouseX10: boolean;
  mouseNormal: boolean;
  mouseButton: boolean;
  mouseAny: boolean;
  mouseUtf8: boolean;
  mouseSgr: boolean;
  mouseSgrPixels: boolean;
  mouseUrxvt: boolean;
  altScroll: boolean;
  altScreen1047: boolean;
  altScreen1049: boolean;
}

export interface GhosttyColorRgb {
  r: number;
  g: number;
  b: number;
}

export type GhosttyRenderDirtyState = 'clean' | 'partial' | 'full';
export type GhosttyCursorVisualStyle = 'bar' | 'block' | 'underline' | 'block-hollow';
export type GhosttyCellWidthKind = 'narrow' | 'wide' | 'spacer-tail' | 'spacer-head';

export interface GhosttyRenderColors {
  background: GhosttyColorRgb;
  foreground: GhosttyColorRgb;
  cursor: GhosttyColorRgb | null;
  palette: GhosttyColorRgb[];
}

export interface GhosttyRenderCursor {
  style: GhosttyCursorVisualStyle;
  visible: boolean;
  blinking: boolean;
  passwordInput: boolean;
  x: number | null;
  y: number | null;
  wideTail: boolean;
}

// 光标在 client（视口）坐标系的垂直范围，供宿主做键盘避让定位（issue #27 follow 模式）。
export interface GhosttyCursorViewportRect {
  top: number;
  bottom: number;
}

export interface GhosttyRenderCellStyle {
  bold: boolean;
  italic: boolean;
  faint: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
  underline: number;
}

export interface GhosttyRenderCell {
  x: number;
  text: string;
  codepoints: number[];
  widthKind: GhosttyCellWidthKind;
  hasText: boolean;
  style: GhosttyRenderCellStyle;
  fgColor: GhosttyColorRgb | null;
  bgColor: GhosttyColorRgb | null;
}

export interface GhosttyRenderRow {
  y: number;
  dirty: boolean;
  wrap: boolean;
  wrapContinuation: boolean;
  text: string;
  cells: GhosttyRenderCell[];
}

export interface GhosttySelectionRect {
  row: number;
  x: number;
  width: number;
}

export interface GhosttyRenderSnapshotMeta {
  cols: number;
  rows: number;
  dirty: GhosttyRenderDirtyState;
  colors: GhosttyRenderColors;
  cursor: GhosttyRenderCursor;
}

export interface TerminalDisposable {
  dispose: () => void;
}

export interface CompatibleBufferLine {
  translateToString: (trimRight: boolean) => string;
}

export interface CompatibleTerminalBuffer {
  active: {
    baseY: number;
    viewportY: number;
    length: number;
    getLine: (index: number) => CompatibleBufferLine | null;
  };
}

export interface CompatibleTerminalLike {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | null;
  readonly textarea: HTMLElement | null;
  readonly buffer: CompatibleTerminalBuffer;
  readonly _core: {
    _renderService: {
      dimensions: {
        css: {
          cell: GhosttyCellDimensions;
        };
      };
    };
  };
  write: (data: string | Uint8Array) => void;
  reset: () => void;
  refresh?: () => void;
  resize: (cols: number, rows: number) => void;
  scrollLines: (amount: number) => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  handleViewportGesture?: (gesture: GhosttyViewportGesture) => boolean;
  isMouseReporting?: () => boolean;
  sendTouchMouseEvent?: (event: {
    action: 'press' | 'motion' | 'release';
    clientX: number;
    clientY: number;
  }) => boolean;
  noteTouchHandled?: () => void;
  /** 打开/关闭平移视口（follower 模式）。关闭时 DOM 与样式回到裁剪语义。 */
  setViewportPan?: (enabled: boolean) => void;
  /** 平移视口的可滚状态；未启用/未挂载时返回 null。 */
  panMetrics?: () => GhosttyPanMetrics | null;
  panBy?: (deltaX: number, deltaY: number) => GhosttyPanDelta;
  exportModeSnapshot?: () => GhosttyTerminalModeSnapshot;
  restoreModeSnapshot?: (snapshot: GhosttyTerminalModeSnapshot) => void;
  clearMouseTrackingModes?: () => void;
  paste: (data: string) => void;
  focus: () => void;
  getCursorViewportRect?: () => GhosttyCursorViewportRect | null;
  /** 实时 cell 尺寸（与 _core._renderService.dimensions.css.cell 同一对象） */
  cellDimensions?: () => GhosttyCellDimensions;
  getSelection?: () => string;
  hasSelection?: () => boolean;
  clearSelection?: () => void;
  setFocused?: (focused: boolean) => void;
  setTheme?: (theme: GhosttyTheme) => void;
  setDisableStdin?: (disabled: boolean) => void;
  forceFullRepaint?: () => void;
  onSelectionChange?: (callback: (text: string | null) => void) => TerminalDisposable;
  onLinkActivated?: (callback: (url: string) => void) => TerminalDisposable;
  /** 回调收到的是经 cwd/授权根解析后的绝对路径 */
  onFileLinkActivated?: (callback: (path: string) => void) => TerminalDisposable;
  setFileLinkContext?: (
    context: { cwd?: string | null; rootPaths: readonly string[] } | null
  ) => void;
  startTouchSelection?: (
    clientX: number,
    clientY: number,
    mode?: 'character' | 'word' | 'line'
  ) => boolean;
  updateTouchSelection?: (clientX: number, clientY: number) => void;
  endTouchSelection?: () => void;
  onData: (callback: (data: string) => void) => TerminalDisposable;
  attachCustomKeyEventHandler: (callback: (event: KeyboardEvent) => boolean) => void;
  loadAddon: (addon: {
    activate: (terminal: CompatibleTerminalLike) => void;
    dispose: () => void;
  }) => void;
  getRendererKind?: () => string;
}
