import { CanvasRenderer } from './canvas-renderer';
import type { FileLinkContext } from './file-path';
import { type GhosttyBindings, getGhosttyBindings } from './ghostty-wasm';
import {
  type GhosttyRenderStateResources,
  createRenderState,
  disposeRenderStateResources,
} from './render-state';
import type { SelectionMode } from './selection-model';
import { TerminalBuffer } from './terminal-buffer';
import { DEFAULT_COLS, DEFAULT_ROWS, GHOSTTY_MODE_ANY_MOUSE } from './terminal-constants';
import { TerminalDomSurface } from './terminal-dom';
import {
  type TerminalInputContext,
  bindClipboardEvents,
  bindCompositionEvents,
  bindInputEvents,
  bindKeyboardEvents,
  createTerminalInputState,
} from './terminal-input';
import {
  type TerminalHandles,
  TerminalInputBridge,
  pointerLikeEventToGhosttyMods,
} from './terminal-input-bridge';
import {
  GHOSTTY_MOUSE_BUTTON_LEFT,
  type PointerEventContext,
  SYNTHETIC_MOUSE_SUPPRESS_MS,
  type TerminalLinkHit,
  bindMouseEvents,
} from './terminal-pointer';
import { type RenderSnapshot, TerminalRenderCoordinator } from './terminal-render-coordinator';
import { TerminalSelection, selectionModeFromClickDetail } from './terminal-selection';
import type {
  CompatibleTerminalLike,
  GhosttyCellDimensions,
  GhosttyCursorViewportRect,
  GhosttyTerminalInitOptions,
  GhosttyTerminalModeSnapshot,
  GhosttyTerminalSize,
  GhosttyViewportGesture,
  TerminalDisposable,
} from './types';

const TERMINAL_ENGINE = 'ghostty-official';
// 同步输出（DECSET 2026）激活期间挂起渲染的兜底时限：应用悬挂或关闭帧迟迟不到时，
// 最迟此间隔后仍强制渲染一次，与主流终端对 2026 的安全阀行为一致。
const SYNCHRONIZED_OUTPUT_FALLBACK_MS = 150;

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

// 终端控制器：持有 WASM handle 的生命周期，并把 DOM 外壳（TerminalDomSurface）、
// 输入编码（TerminalInputBridge）、渲染编排（TerminalRenderCoordinator）与选择状态机
// 串起来，对外暴露 xterm 兼容 API。
export class GhosttyTerminalController implements CompatibleTerminalLike {
  readonly buffer = new TerminalBuffer();
  readonly options: GhosttyTerminalInitOptions;
  // xterm 兼容：cell 尺寸与 DOM 外壳共用同一对象，测量结果就地写入。
  readonly _core: { _renderService: { dimensions: { css: { cell: GhosttyCellDimensions } } } };

  element: HTMLElement | null = null;
  textarea: HTMLElement | null = null;
  cols = DEFAULT_COLS;
  rows = DEFAULT_ROWS;

  private readonly bindings: GhosttyBindings;
  private readonly handles: TerminalHandles;
  private readonly renderState: GhosttyRenderStateResources;
  private readonly dom: TerminalDomSurface;
  private readonly input: TerminalInputBridge;
  private readonly renderCoordinator: TerminalRenderCoordinator;
  private readonly selection: TerminalSelection;
  private readonly inputState = createTerminalInputState();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly selectionListeners = new Set<(text: string | null) => void>();
  private readonly linkListeners = new Set<(url: string) => void>();
  private readonly fileLinkListeners = new Set<(path: string) => void>();
  private readonly addons = new Set<{ dispose: () => void }>();
  private readonly domEventDisposers: Array<() => void> = [];
  private fileLinkContext: FileLinkContext | null = null;
  private lastNotifiedSelectionText: string | null = null;
  private syncOutputFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private disableStdin: boolean;
  private customKeyEventHandler: (event: KeyboardEvent) => boolean = () => true;

  private constructor(
    bindings: GhosttyBindings,
    handles: TerminalHandles,
    renderState: GhosttyRenderStateResources,
    options: GhosttyTerminalInitOptions
  ) {
    this.bindings = bindings;
    this.handles = handles;
    this.renderState = renderState;
    this.options = options;
    this.disableStdin = Boolean(options.disableStdin);
    this.dom = new TerminalDomSurface(options);
    this._core = { _renderService: { dimensions: { css: { cell: this.dom.cell } } } };
    this.input = new TerminalInputBridge(bindings, handles, {
      cellDimensions: () => this.dom.cell,
      screenBounds: () => this.dom.screenBounds(),
      isInputDisabled: () => this.disableStdin,
      emitData: (data) => this.emitData(data),
      viewportCols: () => this.cols,
      viewportRows: () => this.rows,
      scrollLines: (amount) => this.scrollLines(amount),
    });
    this.renderCoordinator = new TerminalRenderCoordinator(
      bindings,
      handles.terminal,
      renderState,
      {
        cellDimensions: () => this.dom.cell,
        screenBounds: () => this.dom.screenBounds(),
        viewportCols: () => this.cols,
        viewportRows: () => this.rows,
        selectionRects: (offset, rows) => this.selection.projectRects(offset, rows),
        selectionText: () => this.selection.getText(),
        selectionColor: () => this.options.theme.selectionBackground,
        fileLinkContext: () => this.fileLinkContext,
        onSnapshot: (snapshot) => this.applyRenderSnapshot(snapshot),
      }
    );
    this.selection = new TerminalSelection({
      getLineModel: (line) => this.renderCoordinator.getLineModel(line),
      hitTest: (clientX, clientY) => this.renderCoordinator.hitTest(clientX, clientY),
      getScreenBounds: () => this.dom.screenBounds(),
      scrollViewportBy: (delta) => {
        this.bindings.scrollViewportDelta(this.handles.terminal, delta);
      },
      render: () => {
        this.renderCoordinator.renderNow();
      },
    });
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
        {
          terminal: terminalHandle,
          keyEncoder: keyEncoderHandle,
          mouseEncoder: mouseEncoderHandle,
        },
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
    if (this.disposed || this.dom.mounted) {
      return;
    }

    const screen = this.dom.mount(container);
    this.element = this.dom.element;
    this.textarea = this.dom.textarea;
    this.renderCoordinator.attach(
      new CanvasRenderer({
        screenElement: screen,
        theme: this.options.theme,
        fontFamily: this.options.fontFamily,
        fontSize: this.options.fontSize,
      })
    );

    this.dom.syncInputState(this.disableStdin);
    this.bindDomEvents();
    this.dom.measureCellDimensions();

    const measured = this.dom.measureSize();
    if (measured) {
      this.resize(measured.cols, measured.rows);
    } else {
      this.renderCoordinator.renderNow();
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
    return this.subscribe(this.dataListeners, callback);
  }

  onSelectionChange(callback: (text: string | null) => void): TerminalDisposable {
    return this.subscribe(this.selectionListeners, callback);
  }

  onLinkActivated(callback: (url: string) => void): TerminalDisposable {
    return this.subscribe(this.linkListeners, callback);
  }

  onFileLinkActivated(callback: (path: string) => void): TerminalDisposable {
    return this.subscribe(this.fileLinkListeners, callback);
  }

  attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean): void {
    this.customKeyEventHandler = callback;
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
    this.renderCoordinator.scheduleLinkOverlayUpdate();
  }

  hasSelection(): boolean {
    return this.selection.hasSelection();
  }

  getSelection(): string {
    return this.selection.getText() ?? '';
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
    this.renderCoordinator.renderNow();
  }

  write(data: string | Uint8Array): void {
    if (this.disposed) {
      return;
    }

    const prevAltScreen = this.input.isAltScreenActive();
    this.bindings.writeVt(this.handles.terminal, data);
    if (prevAltScreen && !this.input.isAltScreenActive()) {
      this.clearMouseTrackingModes();
    }
    // BSU（DECSET 2026）激活期间挂起写触发的渲染：一次原子重绘的字节可能分多个
    // write 到达，rAF 到点就画会把中间态刷上屏（no-flicker TUI 表现为逐行扫描）。
    // ESU 到达的那次 write 会走正常渲染调度；只留低频兜底防应用悬挂。
    if (this.input.isSynchronizedOutputActive()) {
      if (this.syncOutputFallbackTimer === null) {
        this.syncOutputFallbackTimer = setTimeout(() => {
          this.syncOutputFallbackTimer = null;
          this.renderCoordinator.schedule();
        }, SYNCHRONIZED_OUTPUT_FALLBACK_MS);
      }
      return;
    }
    this.cancelSynchronizedOutputFallback();
    this.renderCoordinator.schedule();
  }

  clearMouseTrackingModes(): void {
    if (this.disposed) {
      return;
    }

    this.input.clearMouseTrackingModes();
  }

  reset(): void {
    if (this.disposed) {
      return;
    }

    this.renderCoordinator.invalidateLines();
    this.clearSelectionState(false);
    this.bindings.resetTerminal(this.handles.terminal);
    this.renderCoordinator.schedule();
  }

  refresh(): void {
    if (this.disposed) {
      return;
    }

    this.renderCoordinator.renderNow();
  }

  // 标记 renderer.render 必须全画所有行，并立即同步执行（不等 rAF）。
  // 用于 history 注入（onApplyHistory）等需要内容立即可见的场景：
  // DOM 重插入或容器尺寸变化后 canvas 位图可能已被 resize 清空，但 ghostty 内核
  // 未必同步报 dirty='full'（issue #45 bug 3）。同步 render 消除 rAF 延迟。
  forceFullRepaint(): void {
    if (this.disposed) {
      return;
    }

    this.renderCoordinator.forceFullRepaint();
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
    // 先落内核再提交本地状态：WASM 抛错时 cols/rows 保持旧值，同尺寸重试仍会走到这里；
    // 反过来先写字段会让「控制器尺寸 == 目标尺寸」永久成立而早退，尺寸再也对不回去。
    this.bindings.resizeTerminal(this.handles.terminal, nextCols, nextRows, this.dom.cell);
    this.input.resetMouseEncoder();
    this.cols = nextCols;
    this.rows = nextRows;
    this.renderCoordinator.invalidateLines();
    this.clearSelectionState(false);
    this.renderCoordinator.schedule();
  }

  scrollLines(amount: number): void {
    if (this.disposed || amount === 0) {
      return;
    }

    this.bindings.scrollViewportDelta(this.handles.terminal, amount);
    this.renderCoordinator.renderNow();
  }

  scrollToTop(): void {
    if (this.disposed) {
      return;
    }

    this.bindings.scrollViewportTop(this.handles.terminal);
    this.renderCoordinator.renderNow();
  }

  scrollToBottom(): void {
    if (this.disposed) {
      return;
    }

    this.bindings.scrollViewportBottom(this.handles.terminal);
    this.renderCoordinator.renderNow();
  }

  exportModeSnapshot(): GhosttyTerminalModeSnapshot {
    return this.input.exportModeSnapshot();
  }

  restoreModeSnapshot(snapshot: GhosttyTerminalModeSnapshot): void {
    this.input.restoreModeSnapshot(snapshot);
  }

  // 触摸路由用的有效上报判定：折叠 disposed/disableStdin，hook 据此决定手势分支
  isMouseReporting(): boolean {
    return !this.disposed && !this.disableStdin && this.input.routingState().mouseReporting;
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
      this.dom.showScrollbarTransient();
      this.clearSelectionState();
    }
    return this.input.emitMouseInput({
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
    this.input.mouse.suppressSyntheticUntil = Date.now() + SYNTHETIC_MOUSE_SUPPRESS_MS;
  }

  handleViewportGesture(gesture: GhosttyViewportGesture): boolean {
    if (this.disposed) {
      return false;
    }

    return this.input.handleViewportGesture(gesture);
  }

  paste(data: string): void {
    if (this.disposed || this.disableStdin || !data) {
      return;
    }

    const encoded = this.input.encodePaste(data);
    if (!encoded) {
      return;
    }

    this.emitData(encoded);
  }

  focus(): void {
    this.dom.focusTextarea();
  }

  // 返回光标在 client 坐标系的上/下沿（issue #27「光标对齐」键盘模式用）。
  // 仅当本终端聚焦且光标可见有值时返回，否则 null——避让 hook 据此回退到整页上移
  // （编辑器模式、其他终端聚焦、全屏程序隐藏光标等场景）。复用每帧 render 缓存的
  // 光标快照，不新建临时 render state。
  getCursorViewportRect(): GhosttyCursorViewportRect | null {
    if (this.disposed) {
      return null;
    }
    const cursor = this.renderCoordinator.cursor;
    if (!cursor || !cursor.visible || cursor.y === null || !this.dom.isTextareaFocused()) {
      return null;
    }
    const bounds = this.dom.screenBounds();
    const { height } = this.dom.cell;
    if (!bounds || height <= 0) {
      return null;
    }
    const top = bounds.top + cursor.y * height;
    return { top, bottom: top + height };
  }

  getRendererKind(): string {
    return this.renderCoordinator.rendererKind;
  }

  setTheme(theme: GhosttyTerminalInitOptions['theme']): void {
    this.bindings.setTerminalTheme(this.handles.terminal, theme);
    this.options.theme = theme;
    this.dom.applyTheme(theme);
    this.renderCoordinator.setTheme(theme);
  }

  setDisableStdin(disabled: boolean): void {
    this.disableStdin = disabled;
    this.dom.syncInputState(this.disableStdin);
  }

  setFocused(focused: boolean): void {
    this.dom.setFocused(focused);
  }

  measureSizeFromElement(): GhosttyTerminalSize | null {
    return this.dom.measureSize();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;

    this.renderCoordinator.cancelPending();
    this.selection.stopAutoScroll();
    this.updateSelectionTextProbe(null);
    this.clearDomEventListeners();
    this.dom.cancelScrollbarFade();
    this.renderCoordinator.cancelLinkOverlay();
    this.cancelSynchronizedOutputFallback();

    for (const addon of this.addons) {
      addon.dispose();
    }
    this.addons.clear();

    this.renderCoordinator.dispose();
    this.dom.dispose();
    this.element = null;
    this.textarea = null;

    disposeRenderStateResources(this.renderState);
    this.bindings.freeMouseEncoder(this.handles.mouseEncoder);
    this.bindings.freeKeyEncoder(this.handles.keyEncoder);
    this.bindings.freeTerminal(this.handles.terminal);
  }

  private subscribe<T>(listeners: Set<T>, callback: T): TerminalDisposable {
    listeners.add(callback);
    return {
      dispose: () => {
        listeners.delete(callback);
      },
    };
  }

  private applyRenderSnapshot(snapshot: RenderSnapshot): void {
    const { scrollbar } = snapshot;
    this.cols = snapshot.cols;
    this.rows = snapshot.rows;
    this.buffer.setViewport(
      scrollbar.offset,
      Math.max(0, scrollbar.total - scrollbar.len),
      scrollbar.total,
      snapshot.visibleLines
    );
    this.updateSelectionTextProbe(snapshot.selectionText);
    this.dom.updateScrollbar(scrollbar);
  }

  private cancelSynchronizedOutputFallback(): void {
    if (this.syncOutputFallbackTimer === null) {
      return;
    }

    clearTimeout(this.syncOutputFallbackTimer);
    this.syncOutputFallbackTimer = null;
  }

  private bindDomEvents(): void {
    const root = this.dom.element;
    const textarea = this.dom.textarea;
    if (!root || !textarea) {
      return;
    }

    const inputContext = this.inputContext();
    this.domEventDisposers.push(
      bindMouseEvents(root, this.dom.screenElement ?? root, this.pointerContext()),
      bindKeyboardEvents(textarea, inputContext),
      bindCompositionEvents(textarea, inputContext),
      bindClipboardEvents(textarea, inputContext),
      bindInputEvents(textarea, inputContext)
    );
  }

  private pointerContext(): PointerEventContext {
    return {
      mouse: this.input.mouse,
      isInputDisabled: () => this.disableStdin,
      focusTerminal: () => this.focus(),
      showScrollbarTransient: () => this.dom.showScrollbarTransient(),
      getInputRoutingState: () => this.input.routingState(),
      isAnyEventTrackingEnabled: () => this.input.isModeEnabled(GHOSTTY_MODE_ANY_MOUSE),
      pointerMods: (event) => pointerLikeEventToGhosttyMods(event),
      emitMouseInput: (request) => this.input.emitMouseInput(request),
      clearSelection: () => this.clearSelectionState(),
      linkAtClient: (clientX, clientY) => this.renderCoordinator.linkAt(clientX, clientY),
      activateLink: (hit) => this.activateLink(hit),
      setLinkCursor: (active) => this.dom.setLinkCursor(active),
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
      getSelectionText: () => this.selection.getText(),
      clearSelection: () => this.clearSelectionState(),
      clearTextarea: () => this.dom.clearTextarea(),
      emitData: (data) => this.emitData(data),
      encodeKeyboardEvent: (event, action) => this.input.encodeKeyboardEvent(event, action),
      encodeSyntheticKey: (code) => this.input.encodeSyntheticKey(code),
      runCustomKeyEventHandler: (event) => this.customKeyEventHandler(event),
      syncTextareaPositionToCursor: () => this.syncTextareaPositionToCursor(),
      paste: (text) => this.paste(text),
    };
  }

  private syncTextareaPositionToCursor(): void {
    // 读主 render 缓存的光标快照，避免在 IME 组字期间消费 WASM dirty
    // 导致后续 rAF 渲染看到 dirty='clean' 而漏画（issue #45 bug 4-C）。
    const cursor = this.renderCoordinator.cursor;
    if (!cursor) {
      return;
    }

    this.dom.positionTextareaAtCursor(cursor.x ?? 0, cursor.y ?? 0);
  }

  private emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  private clearSelectionState(repaint = true): void {
    this.selection.reset();
    this.input.resetPointerAccumulation();
    this.inputState.copyShortcutSuppressed = false;
    this.updateSelectionTextProbe(null);

    if (repaint) {
      this.renderCoordinator.renderNow();
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
      this.renderCoordinator.renderNow();
    }
  }

  private activateLink(hit: TerminalLinkHit): void {
    const listeners = hit.kind === 'url' ? this.linkListeners : this.fileLinkListeners;
    const target = hit.kind === 'url' ? hit.url : hit.path;
    for (const listener of listeners) {
      listener(target);
    }
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
