import { getGhosttyKeyCode, getUnshiftedCodepoint } from './ghostty-keycodes';
import { type GhosttyBindings, keyboardEventToGhosttyMods } from './ghostty-wasm';
import {
  DEFAULT_CELL_HEIGHT,
  DEFAULT_CELL_WIDTH,
  GHOSTTY_MODE_ALT_SCREEN,
  GHOSTTY_MODE_ALT_SCREEN_SAVE,
  GHOSTTY_MODE_ALT_SCROLL,
  GHOSTTY_MODE_ANY_MOUSE,
  GHOSTTY_MODE_BUTTON_MOUSE,
  GHOSTTY_MODE_NORMAL_MOUSE,
  GHOSTTY_MODE_SGR_MOUSE,
  GHOSTTY_MODE_SGR_PIXELS_MOUSE,
  GHOSTTY_MODE_SYNCHRONIZED_OUTPUT,
  GHOSTTY_MODE_URXVT_MOUSE,
  GHOSTTY_MODE_UTF8_MOUSE,
  GHOSTTY_MODE_X10_MOUSE,
  MOUSE_TRACKING_MODES,
} from './terminal-constants';
import {
  GHOSTTY_MOUSE_BUTTON_FIVE,
  GHOSTTY_MOUSE_BUTTON_FOUR,
  GHOSTTY_MOUSE_BUTTON_SEVEN,
  GHOSTTY_MOUSE_BUTTON_SIX,
  type InputRoutingState,
  type MouseInputRequest,
  type MouseInputState,
  createMouseInputState,
} from './terminal-pointer';
import type {
  GhosttyCellDimensions,
  GhosttyTerminalModeSnapshot,
  GhosttyViewportGesture,
} from './types';
import { consumeWheelDelta, createWheelAccumulator, roundAwayFromZero } from './wheel-delta';

export type KeyEncodeAction = 'press' | 'repeat' | 'release';

export type TerminalHandles = {
  terminal: number;
  keyEncoder: number;
  mouseEncoder: number;
};

export type InputBridgeHost = {
  cellDimensions(): GhosttyCellDimensions;
  screenBounds(): { left: number; top: number; width: number; height: number } | null;
  isInputDisabled(): boolean;
  emitData(data: string): void;
  viewportCols(): number;
  viewportRows(): number;
  scrollLines(amount: number): void;
};

// 模式快照的字段 ↔ DEC 私有模式号映射；export/restore 共用，顺序即 restore 的下发顺序。
const MODE_SNAPSHOT_FIELDS: ReadonlyArray<readonly [keyof GhosttyTerminalModeSnapshot, number]> = [
  ['mouseX10', GHOSTTY_MODE_X10_MOUSE],
  ['mouseNormal', GHOSTTY_MODE_NORMAL_MOUSE],
  ['mouseButton', GHOSTTY_MODE_BUTTON_MOUSE],
  ['mouseAny', GHOSTTY_MODE_ANY_MOUSE],
  ['mouseUtf8', GHOSTTY_MODE_UTF8_MOUSE],
  ['mouseSgr', GHOSTTY_MODE_SGR_MOUSE],
  ['mouseSgrPixels', GHOSTTY_MODE_SGR_PIXELS_MOUSE],
  ['mouseUrxvt', GHOSTTY_MODE_URXVT_MOUSE],
  ['altScroll', GHOSTTY_MODE_ALT_SCROLL],
  ['altScreen1047', GHOSTTY_MODE_ALT_SCREEN],
  ['altScreen1049', GHOSTTY_MODE_ALT_SCREEN_SAVE],
];

export function pointerLikeEventToGhosttyMods(event: {
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

// 输入侧到 WASM 的桥：终端模式查询/下发、按键与鼠标事件编码、滚轮手势的像素→行列换算。
// 只产出待发送的字节并交给宿主 emitData，不碰 DOM、不碰渲染。
export class TerminalInputBridge {
  readonly mouse: MouseInputState = createMouseInputState();

  private readonly wheelAccumulatorY = createWheelAccumulator();
  private readonly wheelAccumulatorX = createWheelAccumulator();
  private syncOutputModeSupported: boolean | null = null;
  // 模式查询按「代」缓存：每次 isTerminalModeEnabled 都是一次 WASM 导出调用 + 临时内存
  // alloc/free，而一次悬停 / 滚轮就要查最多 7 个模式。任何可能改模式的操作（写 VT、
  // reset、resize、快照恢复、清鼠标上报）都必须 bump 代号，缓存整体作废后按需重查。
  private readonly modeCache = new Map<number, boolean>();
  private modeGeneration = 0;

  constructor(
    private readonly bindings: GhosttyBindings,
    private readonly handles: TerminalHandles,
    private readonly host: InputBridgeHost
  ) {}

  get modeCacheGeneration(): number {
    return this.modeGeneration;
  }

  invalidateModeCache(): void {
    this.modeGeneration += 1;
    this.modeCache.clear();
  }

  isModeEnabled(mode: number): boolean {
    const cached = this.modeCache.get(mode);
    if (cached !== undefined) {
      return cached;
    }
    // 抛错（内核不支持该模式）时不写缓存，交由调用方的兼容分支处理。
    const enabled = this.bindings.isTerminalModeEnabled(this.handles.terminal, mode);
    this.modeCache.set(mode, enabled);
    return enabled;
  }

  isAltScreenActive(): boolean {
    return (
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN) ||
      this.isModeEnabled(GHOSTTY_MODE_ALT_SCREEN_SAVE)
    );
  }

  // 内核不支持 2026 时 isTerminalModeEnabled 会抛错，记住一次就不再试探。
  isSynchronizedOutputActive(): boolean {
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

  routingState(): InputRoutingState {
    const mouseReporting =
      this.isModeEnabled(GHOSTTY_MODE_X10_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_NORMAL_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_BUTTON_MOUSE) ||
      this.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE);
    const altScreen = this.isAltScreenActive();

    return {
      mouseReporting,
      altScroll: !mouseReporting && altScreen && this.isModeEnabled(GHOSTTY_MODE_ALT_SCROLL),
    };
  }

  exportModeSnapshot(): GhosttyTerminalModeSnapshot {
    const snapshot = {} as GhosttyTerminalModeSnapshot;
    for (const [field, mode] of MODE_SNAPSHOT_FIELDS) {
      snapshot[field] = this.isModeEnabled(mode);
    }
    return snapshot;
  }

  restoreModeSnapshot(snapshot: GhosttyTerminalModeSnapshot): void {
    for (const [field, mode] of MODE_SNAPSHOT_FIELDS) {
      this.bindings.setTerminalMode(this.handles.terminal, mode, snapshot[field]);
    }
    this.invalidateModeCache();
    this.bindings.resetMouseEncoder(this.handles.mouseEncoder);
    this.mouse.lastMotionCell = null;
  }

  clearMouseTrackingModes(): void {
    for (const mode of MOUSE_TRACKING_MODES) {
      this.bindings.setTerminalMode(this.handles.terminal, mode, false);
    }
    this.invalidateModeCache();
    this.resetMouseEncoder();
    this.mouse.pressedButtons.clear();
    this.mouse.lastMotionCell = null;
    this.mouse.dragActive = false;
  }

  resetMouseEncoder(): void {
    this.bindings.resetMouseEncoder(this.handles.mouseEncoder);
  }

  // 清空选择时连带复位：残留的按下按钮与半格滚轮余量会让下一次交互从错误状态起步。
  resetPointerAccumulation(): void {
    this.mouse.pressedButtons.clear();
    this.wheelAccumulatorY.pixels = 0;
    this.wheelAccumulatorX.pixels = 0;
  }

  encodeKeyboardEvent(event: KeyboardEvent, action: KeyEncodeAction): string | null {
    const keyCode = getGhosttyKeyCode(event.code);
    if (keyCode === 0) {
      return null;
    }

    const utf8 = event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : null;

    return this.bindings.encodeKeyEvent(this.handles.keyEncoder, this.handles.terminal, {
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
  encodeSyntheticKey(code: string): string | null {
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

  encodePaste(data: string): string | null {
    return this.bindings.encodePaste(this.handles.terminal, data);
  }

  emitMouseInput(request: MouseInputRequest): boolean {
    if (this.host.isInputDisabled()) {
      return false;
    }

    const rect = this.host.screenBounds();
    if (!rect) {
      return false;
    }

    const cell = this.host.cellDimensions();
    const cellWidth = Math.max(1, cell.width || DEFAULT_CELL_WIDTH);
    const cellHeight = Math.max(1, cell.height || DEFAULT_CELL_HEIGHT);
    const x = Math.max(0, Math.min(Math.max(1, rect.width) - 1, request.clientX - rect.left));
    const y = Math.max(0, Math.min(Math.max(1, rect.height) - 1, request.clientY - rect.top));

    // 真实终端只在跨 cell 时发 motion：同 cell 去重（press 记锚、release 清锚）。
    // 1016（SGR-pixels）是像素粒度语义，不去重。
    const motionCol = Math.floor(x / cellWidth);
    const motionRow = Math.floor(y / cellHeight);
    if (request.action === 'motion' && this.isDuplicateMotion(motionCol, motionRow)) {
      return false;
    }

    const payload = this.bindings.encodeMouseEvent(
      this.handles.mouseEncoder,
      this.handles.terminal,
      {
        action: request.action,
        button: request.button,
        mods: request.mods,
        x,
        y,
        anyButtonPressed: request.anyButtonPressed,
        screenWidth: Math.max(1, Math.round(rect.width)),
        screenHeight: Math.max(1, Math.round(rect.height)),
        // cell 尺寸不得取整：cssCell 按物理像素网格对齐可为非整数（如 dpr=2 下 15.5），
        // 渲染与 hitTest 均基于该精确值，取整会让行列换算随坐标增大漂移出 off-by-one
        cellWidth,
        cellHeight,
      }
    );
    if (!payload) {
      return false;
    }

    this.mouse.lastMotionCell =
      request.action === 'release' ? null : { col: motionCol, row: motionRow };
    this.host.emitData(payload);
    return true;
  }

  handleViewportGesture(gesture: GhosttyViewportGesture): boolean {
    const deltaX = gesture.deltaX ?? 0;
    if (gesture.deltaY === 0 && deltaX === 0) {
      return false;
    }

    const routing = this.routingState();
    if (routing.mouseReporting) {
      return this.reportGestureAsMouse(gesture);
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

    this.host.scrollLines(lines);
    return true;
  }

  private isDuplicateMotion(col: number, row: number): boolean {
    const anchor = this.mouse.lastMotionCell;
    return (
      !this.isModeEnabled(GHOSTTY_MODE_SGR_PIXELS_MOUSE) &&
      anchor !== null &&
      anchor.col === col &&
      anchor.row === row
    );
  }

  private reportGestureAsMouse(gesture: GhosttyViewportGesture): boolean {
    const mods = pointerLikeEventToGhosttyMods(gesture);
    const lines = gesture.deltaY === 0 ? 0 : this.gestureToLines(gesture);
    const columns = this.gestureToColumns(gesture);
    const wheelSteps: ReadonlyArray<readonly [number, number]> = [
      [lines, lines < 0 ? GHOSTTY_MOUSE_BUTTON_FOUR : GHOSTTY_MOUSE_BUTTON_FIVE],
      [columns, columns < 0 ? GHOSTTY_MOUSE_BUTTON_SIX : GHOSTTY_MOUSE_BUTTON_SEVEN],
    ];

    let consumed = false;
    for (const [amount, button] of wheelSteps) {
      for (let index = 0; index < Math.abs(amount); index += 1) {
        consumed =
          this.emitMouseInput({
            action: 'press',
            button,
            clientX: gesture.clientX,
            clientY: gesture.clientY,
            mods,
            anyButtonPressed: this.mouse.pressedButtons.size > 0,
          }) || consumed;
      }
    }
    return consumed;
  }

  private emitAltScrollInput(lines: number): boolean {
    const keyCode = getGhosttyKeyCode(lines < 0 ? 'ArrowUp' : 'ArrowDown');
    if (keyCode === 0) {
      return false;
    }

    let consumed = false;
    for (let index = 0; index < Math.abs(lines); index += 1) {
      const payload = this.bindings.encodeKeyEvent(this.handles.keyEncoder, this.handles.terminal, {
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
      this.host.emitData(payload);
      consumed = true;
    }

    return consumed;
  }

  private gestureToLines(gesture: GhosttyViewportGesture): number {
    const cellHeight = this.host.cellDimensions().height || DEFAULT_CELL_HEIGHT;

    if (gesture.source !== 'wheel') {
      return roundAwayFromZero(gesture.deltaY / cellHeight);
    }

    return consumeWheelDelta({
      delta: gesture.deltaY,
      cellSize: cellHeight,
      deltaMode: gesture.deltaMode,
      viewportUnits: this.host.viewportRows(),
      accumulator: this.wheelAccumulatorY,
    });
  }

  private gestureToColumns(gesture: GhosttyViewportGesture): number {
    const deltaX = gesture.deltaX ?? 0;
    if (deltaX === 0) {
      return 0;
    }
    const cellWidth = this.host.cellDimensions().width || DEFAULT_CELL_WIDTH;

    if (gesture.source !== 'wheel') {
      return roundAwayFromZero(deltaX / cellWidth);
    }

    return consumeWheelDelta({
      delta: deltaX,
      cellSize: cellWidth,
      deltaMode: gesture.deltaMode,
      viewportUnits: this.host.viewportCols(),
      accumulator: this.wheelAccumulatorX,
    });
  }
}
