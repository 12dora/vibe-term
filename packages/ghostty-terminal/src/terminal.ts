import { CanvasRenderer } from './canvas-renderer';
import type { FileLinkContext } from './file-path';
import { getGhosttyKeyCode, getUnshiftedCodepoint } from './ghostty-keycodes';
import {
  type GhosttyBindings,
  getGhosttyBindings,
  keyboardEventToGhosttyMods,
} from './ghostty-wasm';
import {
  type GhosttyRenderStateResources,
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from './render-state';
import {
  EMPTY_SELECTION_LINE_MODEL,
  type SelectionLineModel,
  type SelectionMode,
  type SelectionPoint,
  buildLineModel,
} from './selection-model';
import {
  type TerminalInputContext,
  bindClipboardEvents,
  bindCompositionEvents,
  bindInputEvents,
  bindKeyboardEvents,
  createTerminalInputState,
} from './terminal-input';
import { LinkMatchCache, collectLinkUnderlineSegments, findLinkAtPoint } from './terminal-links';
import {
  GHOSTTY_MOUSE_BUTTON_FIVE,
  GHOSTTY_MOUSE_BUTTON_FOUR,
  GHOSTTY_MOUSE_BUTTON_LEFT,
  GHOSTTY_MOUSE_BUTTON_SEVEN,
  GHOSTTY_MOUSE_BUTTON_SIX,
  type InputRoutingState,
  type MouseInputRequest,
  type PointerEventContext,
  SYNTHETIC_MOUSE_SUPPRESS_MS,
  type TerminalLinkHit,
  bindMouseEvents,
  createMouseInputState,
} from './terminal-pointer';
import { TerminalRenderLoop, ThrottledTask } from './terminal-render-loop';
import { TerminalSelection, selectionModeFromClickDetail } from './terminal-selection';
import type {
  CompatibleBufferLine,
  CompatibleTerminalBuffer,
  CompatibleTerminalLike,
  GhosttyCellDimensions,
  GhosttyCursorViewportRect,
  GhosttyRenderCursor,
  GhosttyRenderRow,
  GhosttyTerminalInitOptions,
  GhosttyTerminalModeSnapshot,
  GhosttyTerminalSize,
  GhosttyViewportGesture,
  TerminalDisposable,
} from './types';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_CELL_WIDTH = 9;
const DEFAULT_CELL_HEIGHT = 17;
// 行高倍率默认值（cell 高 = fontSize × lineHeight）。CSS/probe/textarea/cell 计算共用同一来源，
// 避免散落的 '1.2' 漂移。可由 init options.lineHeight 覆盖；cell 高由此唯一确定，不依赖 DOM 测量。
const LINE_HEIGHT = 1.2;
const TERMINAL_ENGINE = 'ghostty-official';
// 链接下划线重算节流：只扫可见区，且相邻两次重算至少间隔此值（trailing 保证终态正确）。
const LINK_OVERLAY_THROTTLE_MS = 150;
const LINK_MATCH_CACHE_LIMIT = 300;

const GHOSTTY_MODE_X10_MOUSE = 9;
const GHOSTTY_MODE_NORMAL_MOUSE = 1000;
const GHOSTTY_MODE_BUTTON_MOUSE = 1002;
const GHOSTTY_MODE_ANY_MOUSE = 1003;
const GHOSTTY_MODE_ALT_SCROLL = 1007;
const GHOSTTY_MODE_ALT_SCREEN = 1047;
const GHOSTTY_MODE_ALT_SCREEN_SAVE = 1049;
const GHOSTTY_MODE_SYNCHRONIZED_OUTPUT = 2026;
// 同步输出（DECSET 2026）激活期间挂起渲染的兜底时限：应用悬挂或关闭帧迟迟不到时，
// 最迟此间隔后仍强制渲染一次，与主流终端对 2026 的安全阀行为一致。
const SYNCHRONIZED_OUTPUT_FALLBACK_MS = 150;

const MOUSE_TRACKING_MODES: readonly number[] = [
  GHOSTTY_MODE_X10_MOUSE,
  GHOSTTY_MODE_NORMAL_MOUSE,
  GHOSTTY_MODE_BUTTON_MOUSE,
  GHOSTTY_MODE_ANY_MOUSE,
];

class BufferLine implements CompatibleBufferLine {
  constructor(private readonly content: string) {}

  translateToString(trimRight: boolean): string {
    return trimRight ? this.content.replace(/\s+$/u, '') : this.content;
  }
}

class TerminalBuffer implements CompatibleTerminalBuffer {
  active = {
    baseY: 0,
    viewportY: 0,
    length: DEFAULT_ROWS,
    getLine: (index: number): CompatibleBufferLine | null => {
      const relativeIndex = index - this.active.viewportY;
      const line = this.visibleLines[relativeIndex];
      return typeof line === 'string' ? new BufferLine(line) : null;
    },
  };

  private visibleLines: string[] = Array.from({ length: DEFAULT_ROWS }, () => '');

  setViewport(viewportY: number, baseY: number, length: number, lines: string[]): void {
    this.active.viewportY = viewportY;
    this.active.baseY = baseY;
    this.active.length = length;
    this.visibleLines = lines;
  }
}

function normalizeVisibleLines(rows: GhosttyRenderRow[], expectedRows: number): string[] {
  const lines = rows.slice(0, expectedRows).map((row) => row.text);
  while (lines.length < expectedRows) {
    lines.push('');
  }
  return lines;
}

function pointerLikeEventToGhosttyMods(event: {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): number {
  return keyboardEventToGhosttyMods({
    shiftKey: Boolean(event.shiftKey),
    ctrlKey: Boolean(event.ctrlKey),
    altKey: Boolean(event.altKey),
    metaKey: Boolean(event.metaKey),
    getModifierState: () => false,
  } as unknown as KeyboardEvent);
}

export class FitAddon {
  private terminal: GhosttyTerminalController | null = null;

  activate(terminal: CompatibleTerminalLike): void {
    this.terminal = terminal instanceof GhosttyTerminalController ? terminal : null;
  }

  fit(): void {
    const proposed = this.proposeDimensions();
    if (!this.terminal || !proposed) {
      return;
    }

    this.terminal.resize(proposed.cols, proposed.rows);
  }

  proposeDimensions(): GhosttyTerminalSize | null {
    return this.terminal?.measureSizeFromElement() ?? null;
  }

  dispose(): void {
    this.terminal = null;
  }
}

export class GhosttyTerminalController implements CompatibleTerminalLike {
  readonly buffer = new TerminalBuffer();
  readonly _core = {
    _renderService: {
      dimensions: {
        css: {
          cell: {
            width: DEFAULT_CELL_WIDTH,
            height: DEFAULT_CELL_HEIGHT,
          },
        },
      },
    },
  };

  readonly options: GhosttyTerminalInitOptions;

  element: HTMLElement | null = null;
  textarea: HTMLElement | null = null;
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;

  private readonly bindings: GhosttyBindings;
  private readonly terminalHandle: number;
  private readonly keyEncoderHandle: number;
  private readonly mouseEncoderHandle: number;
  private readonly renderState: GhosttyRenderStateResources;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly selectionListeners = new Set<(text: string | null) => void>();
  private readonly linkListeners = new Set<(url: string) => void>();
  private readonly fileLinkListeners = new Set<(path: string) => void>();
  private fileLinkContext: FileLinkContext | null = null;
  private readonly linkOverlayTask = new ThrottledTask(LINK_OVERLAY_THROTTLE_MS, () => {
    this.updateLinkOverlay();
  });
  private linkOverlayDrawnOffset = -1;
  private readonly linkMatchCache = new LinkMatchCache(LINK_MATCH_CACHE_LIMIT);
  private linkCursorActive = false;
  private lastNotifiedSelectionText: string | null = null;
  private readonly addons = new Set<{ dispose: () => void }>();
  private screenElement: HTMLDivElement | null = null;
  private renderer: CanvasRenderer | null = null;
  private readonly renderLoop = new TerminalRenderLoop(() => {
    this.render();
  });
  private syncOutputFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private syncOutputModeSupported: boolean | null = null;
  // 每帧 render 缓存的光标快照，供 getCursorViewportRect 读取（issue #27 follow 模式）。
  private lastCursor: GhosttyRenderCursor | null = null;
  private disposed = false;
  private disableStdin: boolean;
  private customKeyEventHandler: (event: KeyboardEvent) => boolean = () => true;
  private readonly inputState = createTerminalInputState();
  private readonly selection = new TerminalSelection({
    getLineModel: (line) => this.getLineModel(line),
    hitTest: (clientX, clientY) => this.hitTest(clientX, clientY),
    getScreenBounds: () => this.screenElement?.getBoundingClientRect() ?? null,
    scrollViewportBy: (delta) => {
      this.bindings.scrollViewportDelta(this.terminalHandle, delta);
    },
    render: () => {
      this.render();
    },
  });
  private readonly lineCache = new Map<number, SelectionLineModel>();
  private lastViewportOffset = 0;
  private lastViewportRows = DEFAULT_ROWS;
  private lastRenderedRows: GhosttyRenderRow[] = [];
  private readonly domEventDisposers: Array<() => void> = [];
  private scrollbarThumb: HTMLDivElement | null = null;
  private scrollbarFadeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollbarVisible = false;
  private focused = true;
  private readonly mouseState = createMouseInputState();
  private wheelPixelDelta = 0;
  private wheelPixelDeltaX = 0;

  private constructor(
    bindings: GhosttyBindings,
    terminalHandle: number,
    keyEncoderHandle: number,
    mouseEncoderHandle: number,
    renderState: GhosttyRenderStateResources,
    options: GhosttyTerminalInitOptions
  ) {
    this.bindings = bindings;
    this.terminalHandle = terminalHandle;
    this.keyEncoderHandle = keyEncoderHandle;
    this.mouseEncoderHandle = mouseEncoderHandle;
    this.renderState = renderState;
    this.options = options;
    this.disableStdin = Boolean(options.disableStdin);
  }

  static async create(options: GhosttyTerminalInitOptions): Promise<GhosttyTerminalController> {
    const bindings = await getGhosttyBindings();
    const terminalHandle = bindings.createTerminal(DEFAULT_COLS, DEFAULT_ROWS, options.scrollback);
    let keyEncoderHandle = 0;
    let mouseEncoderHandle = 0;
    let renderState: GhosttyRenderStateResources | null = null;

    try {
      bindings.setTerminalTheme(terminalHandle, options.theme);
      keyEncoderHandle = bindings.createKeyEncoder();
      mouseEncoderHandle = bindings.createMouseEncoder();
      renderState = createRenderState(bindings);

      return new GhosttyTerminalController(
        bindings,
        terminalHandle,
        keyEncoderHandle,
        mouseEncoderHandle,
        renderState,
        options
      );
    } catch (error) {
      if (renderState) {
        disposeRenderStateResources(renderState);
      }
      if (keyEncoderHandle !== 0) {
        bindings.freeKeyEncoder(keyEncoderHandle);
      }
      if (mouseEncoderHandle !== 0) {
        bindings.freeMouseEncoder(mouseEncoderHandle);
      }
      bindings.freeTerminal(terminalHandle);
      throw error;
    }
  }

  open(container: HTMLElement): void {
    if (this.disposed || this.element) {
      return;
    }

    const root = document.createElement('div');
    root.className = 'xterm';
    root.style.position = 'absolute';
    root.style.inset = '0';
    root.style.overflow = 'hidden';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.backgroundColor = this.options.theme.background;
    root.style.color = this.options.theme.foreground;
    root.style.fontFamily = this.options.fontFamily;
    root.style.fontSize = `${this.options.fontSize}px`;
    root.style.lineHeight = String(this.options.lineHeight ?? LINE_HEIGHT);

    const viewport = document.createElement('div');
    viewport.className = 'xterm-viewport';
    viewport.style.width = '100%';
    viewport.style.height = '100%';
    viewport.style.overflow = 'hidden';
    viewport.style.position = 'relative';

    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    screen.style.width = '100%';
    screen.style.height = '100%';
    screen.style.position = 'relative';
    screen.style.userSelect = 'none';
    screen.style.webkitUserSelect = 'none';
    screen.style.backgroundColor = this.options.theme.background;

    const textarea = document.createElement('div');
    textarea.className = 'xterm-helper-textarea';
    textarea.setAttribute('aria-label', 'Terminal Input');
    textarea.setAttribute('role', 'textbox');
    textarea.setAttribute('contenteditable', 'true');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('spellcheck', 'false');
    textarea.style.position = 'absolute';
    textarea.style.opacity = '1';
    textarea.style.pointerEvents = 'none';
    textarea.style.left = '0';
    textarea.style.top = '0';
    textarea.style.minWidth = '1px';
    textarea.style.minHeight = '1px';
    textarea.style.whiteSpace = 'pre';
    textarea.style.border = '0';
    textarea.style.padding = '0';
    textarea.style.margin = '0';
    textarea.style.color = this.options.theme.foreground;
    textarea.style.backgroundColor = 'transparent';
    textarea.style.caretColor = 'transparent';
    textarea.style.overflow = 'visible';
    textarea.style.outline = 'none';
    textarea.style.boxShadow = 'none';
    textarea.style.fontFamily = this.options.fontFamily;
    textarea.style.fontSize = `${this.options.fontSize}px`;
    textarea.style.userSelect = 'text';
    textarea.style.webkitUserSelect = 'text';

    const scrollbarTrack = document.createElement('div');
    scrollbarTrack.className = 'xterm-scrollbar-track';
    scrollbarTrack.style.position = 'absolute';
    scrollbarTrack.style.top = '0';
    scrollbarTrack.style.right = '0';
    scrollbarTrack.style.width = '8px';
    scrollbarTrack.style.height = '100%';
    scrollbarTrack.style.backgroundColor = 'transparent';
    scrollbarTrack.style.pointerEvents = 'none';

    const scrollbarThumb = document.createElement('div');
    scrollbarThumb.className = 'xterm-scrollbar-thumb';
    scrollbarThumb.style.position = 'absolute';
    scrollbarThumb.style.top = '0';
    scrollbarThumb.style.right = '0';
    scrollbarThumb.style.width = '6px';
    scrollbarThumb.style.marginRight = '1px';
    scrollbarThumb.style.borderRadius = '3px';
    scrollbarThumb.style.backgroundColor = 'rgba(128, 128, 128, 0.5)';
    scrollbarThumb.style.pointerEvents = 'none';
    scrollbarThumb.style.transition = 'opacity 0.15s ease';
    scrollbarThumb.style.opacity = '0';

    scrollbarTrack.appendChild(scrollbarThumb);

    viewport.appendChild(screen);
    root.appendChild(viewport);
    root.appendChild(textarea);
    root.appendChild(scrollbarTrack);
    container.appendChild(root);

    this.element = root;
    this.screenElement = screen;
    this.textarea = textarea;
    this.scrollbarThumb = scrollbarThumb;
    this.renderer = new CanvasRenderer({
      screenElement: screen,
      theme: this.options.theme,
      fontFamily: this.options.fontFamily,
      fontSize: this.options.fontSize,
    });

    this.syncInputState();
    this.bindDomEvents();
    this.updateCellDimensions();

    const measured = this.measureSizeFromElement();
    if (measured) {
      this.resize(measured.cols, measured.rows);
    } else {
      this.render();
    }
  }

  loadAddon(addon: {
    activate: (terminal: CompatibleTerminalLike) => void;
    dispose: () => void;
  }): void {
    addon.activate(this);
    this.addons.add(addon);
  }

  onData(callback: (data: string) => void): TerminalDisposable {
    this.dataListeners.add(callback);
    return {
      dispose: () => {
        this.dataListeners.delete(callback);
      },
    };
  }

  attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean): void {
    this.customKeyEventHandler = callback;
  }

  onSelectionChange(callback: (text: string | null) => void): TerminalDisposable {
    this.selectionListeners.add(callback);
    return {
      dispose: () => {
        this.selectionListeners.delete(callback);
      },
    };
  }

  onLinkActivated(callback: (url: string) => void): TerminalDisposable {
    this.linkListeners.add(callback);
    return {
      dispose: () => {
        this.linkListeners.delete(callback);
      },
    };
  }

  onFileLinkActivated(callback: (path: string) => void): TerminalDisposable {
    this.fileLinkListeners.add(callback);
    return {
      dispose: () => {
        this.fileLinkListeners.delete(callback);
      },
    };
  }

  // 宿主注入文件链接上下文（pane cwd + 该设备已启用授权根）。null 关闭文件链接识别。
  // 候选检测缓存与上下文无关（有效性在使用时过滤），无需失效，仅需重算 overlay。
  setFileLinkContext(context: FileLinkContext | null): void {
    if (this.disposed) {
      return;
    }
    this.fileLinkContext =
      context && context.rootPaths.length > 0
        ? { cwd: context.cwd ?? null, rootPaths: [...context.rootPaths] }
        : null;
    this.scheduleLinkOverlayUpdate();
  }

  hasSelection(): boolean {
    return this.selection.hasSelection();
  }

  getSelection(): string {
    return this.getSelectionText() ?? '';
  }

  clearSelection(): void {
    if (this.disposed) {
      return;
    }

    this.clearSelectionState();
  }

  startTouchSelection(clientX: number, clientY: number, mode: SelectionMode = 'word'): boolean {
    if (this.disposed) {
      return false;
    }

    return this.selection.begin(clientX, clientY, mode);
  }

  updateTouchSelection(clientX: number, clientY: number): void {
    if (this.disposed) {
      return;
    }

    this.selection.update(clientX, clientY);
  }

  endTouchSelection(): void {
    if (this.disposed || !this.selection.dragging) {
      return;
    }

    this.selection.endDrag();
    this.render();
  }

  write(data: string | Uint8Array): void {
    if (this.disposed) {
      return;
    }

    const prevAltScreen = this.isAltScreenActive();
    this.bindings.writeVt(this.terminalHandle, data);
    const nextAltScreen = this.isAltScreenActive();
    if (prevAltScreen && !nextAltScreen) {
      this.clearMouseTrackingModes();
    }
    // BSU（DECSET 2026）激活期间挂起写触发的渲染：一次原子重绘的字节可能分多个
    // write 到达，rAF 到点就画会把中间态刷上屏（no-flicker TUI 表现为逐行扫描）。
    // ESU 到达的那次 write 会走正常渲染调度；只留低频兜底防应用悬挂。
    if (this.isSynchronizedOutputActive()) {
      if (this.syncOutputFallbackTimer === null) {
        this.syncOutputFallbackTimer = setTimeout(() => {
          this.syncOutputFallbackTimer = null;
          this.renderLoop.schedule();
        }, SYNCHRONIZED_OUTPUT_FALLBACK_MS);
      }
      return;
    }
    if (this.syncOutputFallbackTimer !== null) {
      clearTimeout(this.syncOutputFallbackTimer);
      this.syncOutputFallbackTimer = null;
    }
    this.renderLoop.schedule();
  }

  private isSynchronizedOutputActive(): boolean {
    if (this.syncOutputModeSupported === false) {
      return false;
    }
    try {
      const enabled = this.isModeEnabled(GHOSTTY_MODE_SYNCHRONIZED_OUTPUT);
      this.syncOutputModeSupported = true;
      return enabled;
    } catch {
      this.syncOutputModeSupported = false;
      return false;
    }
  }

  clearMouseTrackingModes(): void {
    if (this.disposed) {
      return;
    }
    for (const mode of MOUSE_TRACKING_MODES) {
      this.bindings.setTerminalMode(this.terminalHandle, mode, false);
    }
    this.bindings.resetMouseEncoder(this.mouseEncoderHandle);
    this.mouseState.pressedButtons.clear();
    this.mouseState.lastMotionCell = null;
    this.mouseState.dragActive = false;
  }

  private isAltScreenActive(): boolean {
    return (
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN) ||
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE)
    );
  }

  reset(): void {
    if (this.disposed) {
      return;
    }

    this.lineCache.clear();
    this.clearSelectionState(false);
    this.bindings.resetTerminal(this.terminalHandle);
    this.renderLoop.schedule();
  }

  refresh(): void {
    if (this.disposed) {
      return;
    }

    this.render();
  }

  // 标记 renderer.render 必须全画所有行，并立即同步执行（不等 rAF）。
  // 用于 history 注入（onApplyHistory）等需要内容立即可见的场景：
  // DOM 重插入或容器尺寸变化后 canvas 位图可能已被 resize 清空，但 ghostty 内核
  // 未必同步报 dirty='full'（issue #45 bug 3）。同步 render 消除 rAF 延迟。
  forceFullRepaint(): void {
    if (this.disposed) {
      return;
    }

    this.renderLoop.requestFullRepaint();
    this.render();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }

    const nextCols = Math.max(2, Math.floor(cols));
    const nextRows = Math.max(2, Math.floor(rows));
    if (nextCols === this.cols && nextRows === this.rows) {
      return;
    }
    this.cols = nextCols;
    this.rows = nextRows;
    this.clearSelectionState(false);
    this.bindings.resizeTerminal(this.terminalHandle, nextCols, nextRows, this.cellDimensions());
    this.bindings.resetMouseEncoder(this.mouseEncoderHandle);
    this.renderLoop.schedule();
  }

  scrollLines(amount: number): void {
    if (this.disposed || amount === 0) {
      return;
    }

    this.bindings.scrollViewportDelta(this.terminalHandle, amount);
    this.render();
  }

  scrollToTop(): void {
    if (this.disposed) {
      return;
    }

    this.bindings.scrollViewportTop(this.terminalHandle);
    this.render();
  }

  scrollToBottom(): void {
    if (this.disposed) {
      return;
    }

    this.bindings.scrollViewportBottom(this.terminalHandle);
    this.render();
  }

  exportModeSnapshot(): GhosttyTerminalModeSnapshot {
    return {
      mouseX10: this.isModeEnabled(GHOSTTY_MODE_X10_MOUSE),
      mouseNormal: this.isModeEnabled(GHOSTTY_MODE_NORMAL_MOUSE),
      mouseButton: this.isModeEnabled(GHOSTTY_MODE_BUTTON_MOUSE),
      mouseAny: this.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE),
      mouseUtf8: this.isModeEnabled(1005),
      mouseSgr: this.isModeEnabled(1006),
      mouseSgrPixels: this.isModeEnabled(1016),
      mouseUrxvt: this.isModeEnabled(1015),
      altScroll: this.isModeEnabled(GHOSTTY_MODE_ALT_SCROLL),
      altScreen1047: this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN),
      altScreen1049: this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE),
    };
  }

  restoreModeSnapshot(snapshot: GhosttyTerminalModeSnapshot): void {
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_X10_MOUSE, snapshot.mouseX10);
    this.bindings.setTerminalMode(
      this.terminalHandle,
      GHOSTTY_MODE_NORMAL_MOUSE,
      snapshot.mouseNormal
    );
    this.bindings.setTerminalMode(
      this.terminalHandle,
      GHOSTTY_MODE_BUTTON_MOUSE,
      snapshot.mouseButton
    );
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_ANY_MOUSE, snapshot.mouseAny);
    this.bindings.setTerminalMode(this.terminalHandle, 1005, snapshot.mouseUtf8);
    this.bindings.setTerminalMode(this.terminalHandle, 1006, snapshot.mouseSgr);
    this.bindings.setTerminalMode(this.terminalHandle, 1016, snapshot.mouseSgrPixels);
    this.bindings.setTerminalMode(this.terminalHandle, 1015, snapshot.mouseUrxvt);
    this.bindings.setTerminalMode(this.terminalHandle, GHOSTTY_MODE_ALT_SCROLL, snapshot.altScroll);
    this.bindings.setTerminalMode(
      this.terminalHandle,
      GHOSTTY_MODE_ALT_SCREEN,
      snapshot.altScreen1047
    );
    this.bindings.setTerminalMode(
      this.terminalHandle,
      GHOSTTY_MODE_ALT_SCREEN_SAVE,
      snapshot.altScreen1049
    );
    this.bindings.resetMouseEncoder(this.mouseEncoderHandle);
    this.mouseState.lastMotionCell = null;
  }

  // 触摸路由用的有效上报判定：折叠 disposed/disableStdin，hook 据此决定手势分支
  isMouseReporting(): boolean {
    return !this.disposed && !this.disableStdin && this.getInputRoutingState().mouseReporting;
  }

  // 触摸手势 → 鼠标上报（button 恒为左键，mods=0）。返回 false = 模式已关/编码失败，
  // 调用方（useMobileTouch 状态机）据此中止手势。触摸按钮状态由调用方独占维护，
  // 不写 pressedMouseButtons/mouseDragActive（二者被 clearSelectionState 与真实鼠标共享）。
  sendTouchMouseEvent(event: {
    action: 'press' | 'motion' | 'release';
    clientX: number;
    clientY: number;
  }): boolean {
    if (!this.isMouseReporting()) {
      return false;
    }
    if (event.action === 'press') {
      this.showScrollbarTransient();
      this.clearSelectionState();
    }
    return this.emitMouseInput({
      action: event.action,
      button: GHOSTTY_MOUSE_BUTTON_LEFT,
      clientX: event.clientX,
      clientY: event.clientY,
      mods: 0,
      anyButtonPressed: event.action !== 'release',
    });
  }

  // 触摸手势被消费后调用：开启合成鼠标抑制窗（自 touchend 时刻起算）
  noteTouchHandled(): void {
    this.mouseState.suppressSyntheticUntil = Date.now() + SYNTHETIC_MOUSE_SUPPRESS_MS;
  }

  handleViewportGesture(gesture: GhosttyViewportGesture): boolean {
    const deltaX = gesture.deltaX ?? 0;
    if (this.disposed || (gesture.deltaY === 0 && deltaX === 0)) {
      return false;
    }

    const routing = this.getInputRoutingState();
    if (routing.mouseReporting) {
      let consumed = false;
      const lines = gesture.deltaY === 0 ? 0 : this.gestureToLines(gesture);
      const verticalButton = lines < 0 ? GHOSTTY_MOUSE_BUTTON_FOUR : GHOSTTY_MOUSE_BUTTON_FIVE;
      for (let index = 0; index < Math.abs(lines); index += 1) {
        consumed =
          this.emitMouseInput({
            action: 'press',
            button: verticalButton,
            clientX: gesture.clientX,
            clientY: gesture.clientY,
            mods: pointerLikeEventToGhosttyMods(gesture),
            anyButtonPressed: this.mouseState.pressedButtons.size > 0,
          }) || consumed;
      }
      const columns = this.gestureToColumns(gesture);
      const horizontalButton = columns < 0 ? GHOSTTY_MOUSE_BUTTON_SIX : GHOSTTY_MOUSE_BUTTON_SEVEN;
      for (let index = 0; index < Math.abs(columns); index += 1) {
        consumed =
          this.emitMouseInput({
            action: 'press',
            button: horizontalButton,
            clientX: gesture.clientX,
            clientY: gesture.clientY,
            mods: pointerLikeEventToGhosttyMods(gesture),
            anyButtonPressed: this.mouseState.pressedButtons.size > 0,
          }) || consumed;
      }
      return consumed;
    }

    // 本地视口没有横向滚动概念，非上报模式只消费纵向
    if (gesture.deltaY === 0) {
      return false;
    }
    const lines = this.gestureToLines(gesture);
    if (lines === 0) {
      return false;
    }

    if (routing.altScroll) {
      return this.emitAltScrollInput(lines);
    }

    this.scrollLines(lines);
    return true;
  }

  paste(data: string): void {
    if (this.disposed || this.disableStdin || !data) {
      return;
    }

    const encoded = this.bindings.encodePaste(this.terminalHandle, data);
    if (!encoded) {
      return;
    }

    this.emitData(encoded);
  }

  focus(): void {
    this.textarea?.focus({ preventScroll: true });
  }

  // 返回光标在 client 坐标系的上/下沿（issue #27「光标对齐」键盘模式用）。
  // 仅当本终端聚焦且光标可见有值时返回，否则 null——避让 hook 据此回退到整页上移
  // （编辑器模式、其他终端聚焦、全屏程序隐藏光标等场景）。复用每帧 render 缓存的
  // lastCursor，不新建临时 render state。
  getCursorViewportRect(): GhosttyCursorViewportRect | null {
    if (this.disposed) {
      return null;
    }
    const screen = this.screenElement;
    const cursor = this.lastCursor;
    if (!screen || !cursor || !cursor.visible || cursor.y === null) {
      return null;
    }
    if (this.textarea === null || document.activeElement !== this.textarea) {
      return null;
    }
    const { height } = this.cellDimensions();
    if (height <= 0) {
      return null;
    }
    const top = screen.getBoundingClientRect().top + cursor.y * height;
    return { top, bottom: top + height };
  }

  getRendererKind(): string {
    return this.renderer?.kind ?? 'unknown';
  }

  setTheme(theme: GhosttyTerminalInitOptions['theme']): void {
    this.bindings.setTerminalTheme(this.terminalHandle, theme);
    this.options.theme = theme;

    if (this.element) {
      this.element.style.backgroundColor = theme.background;
      this.element.style.color = theme.foreground;
    }

    if (this.screenElement) {
      this.screenElement.style.backgroundColor = theme.background;
    }

    this.renderer?.setTheme(theme);
    this.renderLoop.schedule();
  }

  setDisableStdin(disabled: boolean): void {
    this.disableStdin = disabled;
    this.syncInputState();
  }

  measureSizeFromElement(): GhosttyTerminalSize | null {
    const element = this.element;
    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const { width, height } = this.cellDimensions();
    if (rect.width === 0 || rect.height === 0 || width <= 0 || height <= 0) {
      return null;
    }

    return {
      cols: Math.max(2, Math.floor(rect.width / width)),
      rows: Math.max(2, Math.floor(rect.height / height)),
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    this.renderLoop.cancelPending();
    this.selection.stopAutoScroll();
    this.updateSelectionTextProbe(null);
    this.clearDomEventListeners();

    if (this.scrollbarFadeTimer) {
      clearTimeout(this.scrollbarFadeTimer);
      this.scrollbarFadeTimer = null;
    }

    this.linkOverlayTask.cancel();
    if (this.syncOutputFallbackTimer !== null) {
      clearTimeout(this.syncOutputFallbackTimer);
      this.syncOutputFallbackTimer = null;
    }
    this.linkMatchCache.clear();

    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons.clear();

    this.renderer?.dispose();
    this.renderer = null;

    this.element?.remove();
    this.element = null;
    this.screenElement = null;
    this.textarea = null;
    this.scrollbarThumb = null;

    disposeRenderStateResources(this.renderState);
    this.bindings.freeMouseEncoder(this.mouseEncoderHandle);
    this.bindings.freeKeyEncoder(this.keyEncoderHandle);
    this.bindings.freeTerminal(this.terminalHandle);
  }

  private cellDimensions(): GhosttyCellDimensions {
    return this._core._renderService.dimensions.css.cell;
  }

  private syncInputState(): void {
    if (!this.textarea) {
      return;
    }

    (this.textarea as any).readOnly = this.disableStdin;
    this.textarea.tabIndex = this.disableStdin ? -1 : 0;
    if (this.disableStdin && document.activeElement === this.textarea) {
      this.textarea.blur();
    }
  }

  private bindDomEvents(): void {
    const root = this.element;
    const textarea = this.textarea;
    if (!root || !textarea) {
      return;
    }

    const inputContext = this.inputContext();
    this.domEventDisposers.push(
      bindMouseEvents(root, this.screenElement ?? root, this.pointerContext()),
      bindKeyboardEvents(textarea, inputContext),
      bindCompositionEvents(textarea, inputContext),
      bindClipboardEvents(textarea, inputContext),
      bindInputEvents(textarea, inputContext)
    );
  }

  private pointerContext(): PointerEventContext {
    return {
      mouse: this.mouseState,
      isInputDisabled: () => this.disableStdin,
      focusTerminal: () => this.focus(),
      showScrollbarTransient: () => this.showScrollbarTransient(),
      getInputRoutingState: () => this.getInputRoutingState(),
      isAnyEventTrackingEnabled: () => this.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE),
      pointerMods: (event) => pointerLikeEventToGhosttyMods(event),
      emitMouseInput: (request) => this.emitMouseInput(request),
      clearSelection: () => this.clearSelectionState(),
      linkAtClient: (clientX, clientY) => this.linkAtClient(clientX, clientY),
      activateLink: (hit) => this.activateLink(hit),
      setLinkCursor: (active) => this.setLinkCursor(active),
      beginPointerSelection: (event) => this.beginPointerSelection(event),
      updatePointerSelection: (event) => this.updatePointerSelection(event),
      finishPointerSelection: (event) => this.finishPointerSelection(event),
      handleViewportGesture: (gesture) => this.handleViewportGesture(gesture),
    };
  }

  private inputContext(): TerminalInputContext {
    return {
      state: this.inputState,
      isInputDisabled: () => this.disableStdin,
      getSelectionText: () => this.getSelectionText(),
      clearSelection: () => this.clearSelectionState(),
      clearTextarea: () => this.clearTextarea(),
      emitData: (data) => this.emitData(data),
      encodeKeyboardEvent: (event, action) => this.encodeKeyboardEvent(event, action),
      encodeSyntheticKey: (code) => this.encodeSyntheticKey(code),
      runCustomKeyEventHandler: (event) => this.customKeyEventHandler(event),
      syncTextareaPositionToCursor: () => this.syncTextareaPositionToCursor(),
      paste: (text) => this.paste(text),
    };
  }

  private encodeKeyboardEvent(
    event: KeyboardEvent,
    action: 'press' | 'repeat' | 'release'
  ): string | null {
    const keyCode = getGhosttyKeyCode(event.code);
    if (keyCode === 0) {
      return null;
    }

    const utf8 = event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : null;

    return this.bindings.encodeKeyEvent(this.keyEncoderHandle, this.terminalHandle, {
      action,
      keyCode,
      mods: keyboardEventToGhosttyMods(event),
      composing: event.isComposing,
      utf8,
      unshiftedCodepoint: getUnshiftedCodepoint(event.code),
    });
  }

  // 把无 keydown 的输入意图（如 Android beforeinput 的删除）合成成等价按键编码，
  // 与真实 keydown 路径产出一致，避免平台间行为分叉。
  private encodeSyntheticKey(code: string): string | null {
    const syntheticEvent = {
      code,
      key: code,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      getModifierState: () => false,
    } as unknown as KeyboardEvent;
    return this.encodeKeyboardEvent(syntheticEvent, 'press');
  }

  private getInputRoutingState(): InputRoutingState {
    const mouseReporting =
      this.isModeEnabled(GHOSTTY_MODE_X10_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_NORMAL_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_BUTTON_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE);
    const altScreen =
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN) ||
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE);

    return {
      mouseReporting,
      altScroll: !mouseReporting && altScreen && this.isModeEnabled(GHOSTTY_MODE_ALT_SCROLL),
    };
  }

  private gestureToLines(gesture: GhosttyViewportGesture): number {
    const cellHeight = this.cellDimensions().height || DEFAULT_CELL_HEIGHT;

    if (gesture.source === 'wheel') {
      if (gesture.deltaMode === 1) {
        this.wheelPixelDelta = 0;
        return gesture.deltaY > 0 ? Math.ceil(gesture.deltaY) : Math.floor(gesture.deltaY);
      }

      if (gesture.deltaMode === 2) {
        this.wheelPixelDelta = 0;
        const pageLines = Math.max(1, this.rows);
        const scaled = gesture.deltaY * pageLines;
        return scaled > 0 ? Math.ceil(scaled) : Math.floor(scaled);
      }

      this.wheelPixelDelta += gesture.deltaY;
      const lines =
        this.wheelPixelDelta > 0
          ? Math.floor(this.wheelPixelDelta / cellHeight)
          : Math.ceil(this.wheelPixelDelta / cellHeight);
      if (lines !== 0) {
        this.wheelPixelDelta -= lines * cellHeight;
      }
      return lines;
    }

    return gesture.deltaY > 0
      ? Math.ceil(gesture.deltaY / cellHeight)
      : Math.floor(gesture.deltaY / cellHeight);
  }

  private gestureToColumns(gesture: GhosttyViewportGesture): number {
    const deltaX = gesture.deltaX ?? 0;
    if (deltaX === 0) {
      return 0;
    }
    const cellWidth = this.cellDimensions().width || DEFAULT_CELL_WIDTH;

    if (gesture.source === 'wheel') {
      if (gesture.deltaMode === 1) {
        this.wheelPixelDeltaX = 0;
        return deltaX > 0 ? Math.ceil(deltaX) : Math.floor(deltaX);
      }

      if (gesture.deltaMode === 2) {
        this.wheelPixelDeltaX = 0;
        const pageColumns = Math.max(1, this.cols);
        const scaled = deltaX * pageColumns;
        return scaled > 0 ? Math.ceil(scaled) : Math.floor(scaled);
      }

      this.wheelPixelDeltaX += deltaX;
      const columns =
        this.wheelPixelDeltaX > 0
          ? Math.floor(this.wheelPixelDeltaX / cellWidth)
          : Math.ceil(this.wheelPixelDeltaX / cellWidth);
      if (columns !== 0) {
        this.wheelPixelDeltaX -= columns * cellWidth;
      }
      return columns;
    }

    return deltaX > 0 ? Math.ceil(deltaX / cellWidth) : Math.floor(deltaX / cellWidth);
  }

  private isModeEnabled(mode: number): boolean {
    return this.bindings.isTerminalModeEnabled(this.terminalHandle, mode);
  }

  private pointerPositionFromClient(
    clientX: number,
    clientY: number
  ): { x: number; y: number } | null {
    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(width - 1, clientX - rect.left)),
      y: Math.max(0, Math.min(height - 1, clientY - rect.top)),
    };
  }

  private emitMouseInput(options: MouseInputRequest): boolean {
    if (this.disableStdin) {
      return false;
    }

    const position = this.pointerPositionFromClient(options.clientX, options.clientY);
    if (!position) {
      return false;
    }

    const cell = this.cellDimensions();
    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      return false;
    }

    // 真实终端只在跨 cell 时发 motion：同 cell 去重（press 记锚、release 清锚）。
    // 1016（SGR-pixels）是像素粒度语义，不去重。
    const motionCol = Math.floor(position.x / Math.max(1, cell.width || DEFAULT_CELL_WIDTH));
    const motionRow = Math.floor(position.y / Math.max(1, cell.height || DEFAULT_CELL_HEIGHT));
    if (
      options.action === 'motion' &&
      !this.isModeEnabled(1016) &&
      this.mouseState.lastMotionCell &&
      this.mouseState.lastMotionCell.col === motionCol &&
      this.mouseState.lastMotionCell.row === motionRow
    ) {
      return false;
    }

    const payload = this.bindings.encodeMouseEvent(this.mouseEncoderHandle, this.terminalHandle, {
      action: options.action,
      button: options.button,
      mods: options.mods,
      x: position.x,
      y: position.y,
      anyButtonPressed: options.anyButtonPressed,
      screenWidth: Math.max(1, Math.round(rect.width)),
      screenHeight: Math.max(1, Math.round(rect.height)),
      // cell 尺寸不得取整：cssCell 按物理像素网格对齐可为非整数（如 dpr=2 下 15.5），
      // 渲染与 hitTest 均基于该精确值，取整会让行列换算随坐标增大漂移出 off-by-one
      cellWidth: Math.max(1, cell.width || DEFAULT_CELL_WIDTH),
      cellHeight: Math.max(1, cell.height || DEFAULT_CELL_HEIGHT),
    });
    if (!payload) {
      return false;
    }

    if (options.action === 'release') {
      this.mouseState.lastMotionCell = null;
    } else {
      this.mouseState.lastMotionCell = { col: motionCol, row: motionRow };
    }

    this.emitData(payload);
    return true;
  }

  private emitAltScrollInput(lines: number): boolean {
    const keyCode = getGhosttyKeyCode(lines < 0 ? 'ArrowUp' : 'ArrowDown');
    if (keyCode === 0) {
      return false;
    }

    let consumed = false;
    for (let index = 0; index < Math.abs(lines); index += 1) {
      const payload = this.bindings.encodeKeyEvent(this.keyEncoderHandle, this.terminalHandle, {
        action: 'press',
        keyCode,
        mods: 0,
        composing: false,
        utf8: null,
        unshiftedCodepoint: null,
      });
      if (!payload) {
        continue;
      }
      this.emitData(payload);
      consumed = true;
    }

    return consumed;
  }

  private emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  private clearTextarea(): void {
    if (this.textarea) {
      this.textarea.textContent = '';
    }
  }

  private syncTextareaPositionToCursor(): void {
    const textarea = this.textarea;
    const screen = this.screenElement;
    if (!textarea || !screen) {
      return;
    }

    const { width, height } = this.cellDimensions();
    if (width <= 0 || height <= 0) {
      return;
    }

    // 改读主 render 缓存的 lastCursor，避免在 IME 组字期间消费 WASM dirty
    // 导致后续 rAF 渲染看到 dirty='clean' 而漏画（issue #45 bug 4-C）。
    if (!this.lastCursor) {
      return;
    }

    const cursorX = this.lastCursor.x ?? 0;
    const cursorY = this.lastCursor.y ?? 0;

    const left = cursorX * width;
    const top = cursorY * height;

    textarea.style.left = `${left}px`;
    textarea.style.top = `${top}px`;
    textarea.style.width = `${Math.max(1, width)}px`;
    textarea.style.height = `${Math.max(1, height)}px`;
    textarea.style.lineHeight = `${height}px`;
    textarea.style.fontFamily = this.options.fontFamily;
    textarea.style.fontSize = `${this.options.fontSize}px`;
  }

  private render(): void {
    if (this.disposed || !this.screenElement || !this.renderer) {
      return;
    }

    // 本帧若被 forceFullRepaint 标记，传给 renderer 让它绕过 dirty='clean' 早退
    //（issue #45 bug 3）。
    const forceFull = this.renderLoop.consumeForceFull();

    const scrollbar = this.bindings.readScrollbar(this.terminalHandle);
    const viewportRows = Math.max(1, scrollbar.len || this.rows);

    updateRenderState(this.renderState, this.terminalHandle);
    const meta = readRenderSnapshotMeta(this.renderState);
    const rows = Array.from(iterateRows(this.renderState));

    this.lastCursor = meta.cursor;
    this.cols = Math.max(2, meta.cols);
    this.rows = Math.max(2, meta.rows || viewportRows);
    this.lastViewportOffset = scrollbar.offset;
    this.lastViewportRows = this.rows;
    this.lastRenderedRows = rows;

    for (const row of rows) {
      this.lineCache.set(scrollbar.offset + row.y, buildLineModel(row.cells, row.wrap));
    }

    const selectionRects = this.selection.projectRects(
      this.lastViewportOffset,
      this.lastViewportRows
    );
    const selectionText = this.getSelectionText();

    this.renderer.render({
      meta,
      rows,
      cellDimensions: this.cellDimensions(),
      selectionRects,
      selectionColor: this.options.theme.selectionBackground,
      forceFull,
    });

    const visibleLines = normalizeVisibleLines(rows, this.rows);
    const baseY = Math.max(0, scrollbar.total - scrollbar.len);
    this.buffer.setViewport(scrollbar.offset, baseY, scrollbar.total, visibleLines);
    this.updateSelectionTextProbe(selectionText);
    this.updateScrollbar(scrollbar);

    // 滚动后旧下划线位置立刻失效：先清空避免错位残影，再等节流重算。
    if (this.linkOverlayDrawnOffset !== -1 && this.linkOverlayDrawnOffset !== scrollbar.offset) {
      this.linkOverlayDrawnOffset = -1;
      this.renderer.clearLinkUnderlines();
    }
    this.scheduleLinkOverlayUpdate();
  }

  private scheduleLinkOverlayUpdate(): void {
    if (this.disposed) {
      return;
    }

    this.linkOverlayTask.schedule();
  }

  private updateLinkOverlay(): void {
    if (this.disposed || !this.renderer) {
      return;
    }

    const offset = this.lastViewportOffset;
    const segments = collectLinkUnderlineSegments({
      offset,
      rows: this.lastViewportRows,
      getLineModel: (line) => this.getLineModel(line),
      cache: this.linkMatchCache,
      fileLinkContext: this.fileLinkContext,
    });

    this.linkOverlayDrawnOffset = offset;
    this.renderer.drawLinkUnderlines(segments);
  }

  private updateScrollbar(scrollbar: { total: number; offset: number; len: number }): void {
    const thumb = this.scrollbarThumb;
    if (!thumb) {
      return;
    }

    const trackHeight = this.screenElement?.clientHeight ?? 0;
    if (trackHeight === 0 || scrollbar.total <= scrollbar.len) {
      thumb.style.opacity = '0';
      return;
    }

    const ratio = scrollbar.len / scrollbar.total;
    const thumbHeight = Math.max(20, ratio * trackHeight);
    const scrollRatio = scrollbar.offset / Math.max(1, scrollbar.total - scrollbar.len);
    const thumbTop = scrollRatio * (trackHeight - thumbHeight);

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
    thumb.style.opacity = this.scrollbarVisible ? '1' : '0';
  }

  private showScrollbarTransient(): void {
    if (!this.focused || !this.scrollbarThumb) {
      return;
    }
    this.scrollbarVisible = true;
    this.scrollbarThumb.style.opacity = '1';
    if (this.scrollbarFadeTimer) {
      clearTimeout(this.scrollbarFadeTimer);
    }
    this.scrollbarFadeTimer = setTimeout(() => {
      this.scrollbarVisible = false;
      if (this.scrollbarThumb) {
        this.scrollbarThumb.style.opacity = '0';
      }
    }, 3000);
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (!focused) {
      this.scrollbarVisible = false;
      if (this.scrollbarThumb) {
        this.scrollbarThumb.style.opacity = '0';
      }
      if (this.scrollbarFadeTimer) {
        clearTimeout(this.scrollbarFadeTimer);
        this.scrollbarFadeTimer = null;
      }
    }
  }

  private updateCellDimensions(): void {
    if (!this.element) {
      return;
    }

    // 仅测量字符宽度（advance）——这确属字体相关、必须测。高度不测：inline 元素的
    // getBoundingClientRect().height 跨引擎语义不一（Chromium≈line box、WebKit≈字体
    // content-area），同字体同 line-height 也会差像素，导致跨平台行高不一致。
    const probe = document.createElement('span');
    probe.textContent = 'WWWWWWWWWW';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = this.options.fontFamily;
    probe.style.fontSize = `${this.options.fontSize}px`;

    this.element.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();

    // CSS cell 对齐到物理像素网格（与 CanvasRenderer 的整数设备像素 cell 一致），
    // 否则小数 cell 会让布局（cols/rows、hit-test）与渲染网格逐格漂移。
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const rawWidth = rect.width > 0 ? rect.width / 10 : DEFAULT_CELL_WIDTH;
    // cell 高确定式计算 = fontSize × lineHeight，规范唯一确定，enforce 跨平台一致。
    const rawHeight = this.options.fontSize * (this.options.lineHeight ?? LINE_HEIGHT);
    this._core._renderService.dimensions.css.cell.width =
      Math.max(1, Math.round(rawWidth * dpr)) / dpr;
    this._core._renderService.dimensions.css.cell.height =
      Math.max(1, Math.round(rawHeight * dpr)) / dpr;
  }

  private clearSelectionState(repaint = true): void {
    this.selection.reset();
    this.mouseState.pressedButtons.clear();
    this.wheelPixelDelta = 0;
    this.inputState.copyShortcutSuppressed = false;
    this.updateSelectionTextProbe(null);

    if (repaint && this.screenElement && this.renderer) {
      this.render();
    }
  }

  private beginPointerSelection(event: MouseEvent): void {
    this.selection.begin(event.clientX, event.clientY, selectionModeFromClickDetail(event.detail));
  }

  private updatePointerSelection(event: MouseEvent): void {
    this.selection.update(event.clientX, event.clientY);
  }

  private finishPointerSelection(event: MouseEvent): void {
    const outcome = this.selection.finishPointerDrag(event);
    if (outcome === 'clear') {
      this.clearSelectionState();
      return;
    }

    if (outcome === 'keep') {
      this.render();
    }
  }

  private hitTest(clientX: number, clientY: number): SelectionPoint | null {
    const rect = this.screenElement?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    const { width, height } = this.cellDimensions();
    if (width <= 0 || height <= 0) {
      return null;
    }

    const relativeX = clientX - rect.left;
    const relativeY = clientY - rect.top;
    const maxCol = Math.max(this.cols - 1, 0);
    const maxRow = Math.max(this.lastViewportRows - 1, 0);
    const col = Math.max(0, Math.min(maxCol, Math.floor(relativeX / width)));
    const row = Math.max(0, Math.min(maxRow, Math.floor(relativeY / height)));

    return {
      line: this.lastViewportOffset + row,
      col,
    };
  }

  private getLineModel(line: number): SelectionLineModel {
    const cached = this.lineCache.get(line);
    if (cached) {
      return cached;
    }

    const visibleIndex = line - this.lastViewportOffset;
    const visibleRow = this.lastRenderedRows[visibleIndex];
    return visibleRow
      ? buildLineModel(visibleRow.cells, visibleRow.wrap)
      : EMPTY_SELECTION_LINE_MODEL;
  }

  private emitLinkActivated(url: string): void {
    for (const listener of this.linkListeners) {
      listener(url);
    }
  }

  private emitFileLinkActivated(path: string): void {
    for (const listener of this.fileLinkListeners) {
      listener(path);
    }
  }

  private setLinkCursor(active: boolean): void {
    if (this.linkCursorActive === active) {
      return;
    }
    this.linkCursorActive = active;
    if (this.screenElement) {
      this.screenElement.style.cursor = active ? 'pointer' : '';
    }
  }

  private linkAtClient(clientX: number, clientY: number): TerminalLinkHit | null {
    const point = this.hitTest(clientX, clientY);
    if (!point) {
      return null;
    }

    return findLinkAtPoint({
      line: point.line,
      col: point.col,
      getLineModel: (line) => this.getLineModel(line),
      cache: this.linkMatchCache,
      fileLinkContext: this.fileLinkContext,
    });
  }

  private activateLink(hit: TerminalLinkHit): void {
    if (hit.kind === 'url') {
      this.emitLinkActivated(hit.url);
      return;
    }

    this.emitFileLinkActivated(hit.path);
  }

  private getSelectionText(): string | null {
    return this.selection.getText();
  }

  private updateSelectionTextProbe(value: string | null): void {
    (
      globalThis as { __tmexE2eTerminalSelectionText?: string | null }
    ).__tmexE2eTerminalSelectionText = value;

    if (value !== this.lastNotifiedSelectionText) {
      this.lastNotifiedSelectionText = value;
      for (const listener of this.selectionListeners) {
        listener(value);
      }
    }
  }

  private clearDomEventListeners(): void {
    while (this.domEventDisposers.length > 0) {
      const dispose = this.domEventDisposers.pop();
      dispose?.();
    }
  }
}

export async function createTerminalController(
  options: GhosttyTerminalInitOptions
): Promise<GhosttyTerminalController> {
  return GhosttyTerminalController.create(options);
}

export { TERMINAL_ENGINE };
