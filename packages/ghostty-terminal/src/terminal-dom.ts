import { ScreenRectCache, type TerminalScreenRect } from './screen-rect-cache';
import { DEFAULT_CELL_HEIGHT, DEFAULT_CELL_WIDTH, LINE_HEIGHT } from './terminal-constants';
import {
  createRootElement,
  createScreenElement,
  createScrollbarElements,
  createTextareaElement,
  createViewportElement,
} from './terminal-dom-elements';
import type {
  GhosttyCellDimensions,
  GhosttyPanDelta,
  GhosttyPanMetrics,
  GhosttyTerminalInitOptions,
  GhosttyTerminalSize,
  GhosttyTheme,
} from './types';

const SCROLLBAR_FADE_MS = 3000;

// iOS 惯性滚动的历史开关，标准 CSSOM 里没有；用交叉类型直接赋值，不支持的引擎上是惰性属性。
type PanViewportStyle = CSSStyleDeclaration & { webkitOverflowScrolling?: string };

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, value));
}

// 淡出 deadline 用单调时钟，墙钟回拨不会让滚动条提前消失 / 长期挂着。
function monotonicNow(): number {
  return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

export type TerminalScrollbarState = {
  total: number;
  offset: number;
  len: number;
};

// 终端的 DOM 外壳：元素树、几何测量（cell 尺寸 / 视口尺寸 / 命中坐标基准）、
// helper textarea 定位与滚动条显隐。不含任何 WASM 或渲染内容逻辑。
export class TerminalDomSurface {
  // 与 controller 的 xterm 兼容字段 `_core._renderService.dimensions.css.cell` 同一对象，
  // 测量结果就地写入，避免两份尺寸各自漂移。
  readonly cell: GhosttyCellDimensions = {
    width: DEFAULT_CELL_WIDTH,
    height: DEFAULT_CELL_HEIGHT,
  };

  private root: HTMLElement | null = null;
  // .xterm-viewport 兼任平移视口（pan 开启时 overflow:auto），.xterm-screen 兼任内容表面
  //（pan 开启时 CSS 尺寸 = cols×cellW / rows×cellH）。两者都是既有元素，pan 关闭时
  // DOM 与样式与以往完全一致。
  private viewport: HTMLDivElement | null = null;
  private screen: HTMLDivElement | null = null;
  private helperTextarea: HTMLElement | null = null;
  private scrollbarThumb: HTMLDivElement | null = null;
  private scrollbarFadeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollbarFadeDeadline = 0;
  private scrollbarVisible = false;
  private focused = true;
  private linkCursorActive = false;
  private panEnabled = false;
  private contentWidth = 0;
  private contentHeight = 0;
  private cursorCell: { x: number; y: number } | null = null;
  // 布局属性缓存：滚动轨道高度与平移可滚量只随容器尺寸 / 内容表面尺寸变化，
  // 却曾经被每个 wheel / touchmove 事件读一次，与紧邻的样式写构成强制同步布局。
  private trackHeight: number | null = null;
  private panOverflow: { x: number; y: number } | null = null;
  private readonly screenRect = new ScreenRectCache();
  private layoutObserver: ResizeObserver | null = null;
  // 最近一次真正写进 thumb 的样式值：thumb.style.height 影响布局，无条件重写会让
  // 布局树每帧失效，于是下一次读 clientHeight 必须先跑一次同步布局。
  private lastThumbHeight = '';
  private lastThumbTransform = '';
  private lastThumbOpacity = '0';

  constructor(private readonly options: GhosttyTerminalInitOptions) {}

  get element(): HTMLElement | null {
    return this.root;
  }

  get screenElement(): HTMLDivElement | null {
    return this.screen;
  }

  get textarea(): HTMLElement | null {
    return this.helperTextarea;
  }

  get mounted(): boolean {
    return this.root !== null;
  }

  // 返回 .xterm-screen：canvas 渲染层直接挂在它上面，调用方无需再从可空字段里取。
  mount(container: HTMLElement): HTMLDivElement {
    const root = createRootElement(this.options);
    const viewport = createViewportElement();
    const screen = createScreenElement(this.options);
    const textarea = createTextareaElement(this.options);
    const scrollbar = createScrollbarElements();

    viewport.appendChild(screen);
    root.appendChild(viewport);
    root.appendChild(textarea);
    root.appendChild(scrollbar.track);
    container.appendChild(root);

    this.root = root;
    this.viewport = viewport;
    this.screen = screen;
    this.helperTextarea = textarea;
    this.scrollbarThumb = scrollbar.thumb;
    this.screenRect.observeGlobalLayout();
    viewport.addEventListener('scroll', this.handlePanScroll, { passive: true });
    this.observeViewportLayout(viewport);
    return screen;
  }

  // 容器尺寸变化是布局缓存唯一的外部失效源（内容表面尺寸变化走 setContentSurfaceSize）。
  // 观察 .xterm-viewport 的内容盒：平移开启后滚动条出现/消失只改它、不改 root。
  private observeViewportLayout(viewport: HTMLDivElement): void {
    if (typeof ResizeObserver !== 'function') {
      return;
    }

    this.layoutObserver = new ResizeObserver(() => {
      this.invalidateLayoutMetrics();
    });
    this.layoutObserver.observe(viewport);
  }

  invalidateLayoutMetrics(): void {
    this.trackHeight = null;
    this.panOverflow = null;
    this.screenRect.invalidate();
  }

  // 0 不入缓存：首帧布局未落地时读到的 0 会永久粘住（无 ResizeObserver 的环境尤甚）。
  private readTrackHeight(): number {
    if (this.trackHeight !== null) {
      return this.trackHeight;
    }

    const measured = this.viewport?.clientHeight ?? 0;
    if (measured > 0) {
      this.trackHeight = measured;
    }
    return measured;
  }

  private readPanOverflow(viewport: HTMLDivElement): { x: number; y: number } {
    if (this.panOverflow !== null) {
      return this.panOverflow;
    }

    const overflow = {
      x: Math.max(0, viewport.scrollWidth - viewport.clientWidth),
      y: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    };
    this.panOverflow = overflow;
    return overflow;
  }

  // follower（他人拥有 PTY 尺寸）时打开：超尺寸的内容表面完整绘制，由平移视口裁剪 + 双向滚动。
  setViewportPan(enabled: boolean): void {
    if (this.panEnabled === enabled) {
      return;
    }

    this.panEnabled = enabled;
    this.invalidateLayoutMetrics();
    this.applyPanStyles();
  }

  get viewportPanEnabled(): boolean {
    return this.panEnabled;
  }

  // CanvasRenderer 每次几何变化后回调，记录内容表面应有的 CSS 尺寸。
  setContentSurfaceSize(width: number, height: number): void {
    this.contentWidth = width;
    this.contentHeight = height;
    this.invalidateLayoutMetrics();
    this.applyContentSurfaceStyles();
  }

  // scrollLeft/scrollTop 必须实时读（平移每一步都在变），但它们不触发布局；
  // 触发布局的 scrollWidth/clientWidth 一类走缓存。
  panMetrics(): GhosttyPanMetrics | null {
    const viewport = this.viewport;
    if (!this.panEnabled || !viewport) {
      return null;
    }

    const overflow = this.readPanOverflow(viewport);
    return {
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
      overflowX: overflow.x,
      overflowY: overflow.y,
    };
  }

  // 返回真正落地的位移（夹取到可滚范围内），调用方据此把余量回退给 scrollback。
  panBy(deltaX: number, deltaY: number): GhosttyPanDelta {
    const viewport = this.viewport;
    const metrics = this.panMetrics();
    if (!viewport || !metrics) {
      return { deltaX: 0, deltaY: 0 };
    }

    viewport.scrollLeft = clamp(metrics.scrollLeft + deltaX, metrics.overflowX);
    viewport.scrollTop = clamp(metrics.scrollTop + deltaY, metrics.overflowY);
    return {
      deltaX: viewport.scrollLeft - metrics.scrollLeft,
      deltaY: viewport.scrollTop - metrics.scrollTop,
    };
  }

  private applyPanStyles(): void {
    const viewport = this.viewport;
    if (!viewport) {
      return;
    }

    if (this.panEnabled) {
      viewport.dataset.panViewport = 'true';
      viewport.style.overflow = 'auto';
      viewport.style.overscrollBehavior = 'contain';
      // 平移由手势状态机以像素为单位驱动，交给原生触摸滚动会与之打架（首指位移先被
      // 原生吃掉，preventDefault 已不可撤销），故禁用原生触摸手势。
      viewport.style.touchAction = 'none';
      (viewport.style as PanViewportStyle).webkitOverflowScrolling = 'touch';
    } else {
      viewport.dataset.panViewport = '';
      viewport.style.overflow = 'hidden';
      viewport.style.overscrollBehavior = '';
      viewport.style.touchAction = '';
      (viewport.style as PanViewportStyle).webkitOverflowScrolling = '';
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }

    this.applyContentSurfaceStyles();
  }

  private applyContentSurfaceStyles(): void {
    const screen = this.screen;
    if (!screen) {
      return;
    }

    // 首帧渲染前还没有内容尺寸：保持铺满，避免出现 0×0 的内容表面。
    if (!this.panEnabled || this.contentWidth <= 0 || this.contentHeight <= 0) {
      screen.style.width = '100%';
      screen.style.height = '100%';
      return;
    }

    screen.style.width = `${this.contentWidth}px`;
    screen.style.height = `${this.contentHeight}px`;
  }

  // 平移时 helper textarea（IME 候选框锚点）挂在 root 上不会跟着动，按滚动偏移重贴。
  private readonly handlePanScroll = (): void => {
    // 内容表面随平移位移，rect 的 left/top 随之改变。
    this.screenRect.invalidate();
    if (!this.panEnabled || !this.cursorCell) {
      return;
    }

    this.positionTextareaAtCursor(this.cursorCell.x, this.cursorCell.y);
  };

  applyTheme(theme: GhosttyTheme): void {
    if (this.root) {
      this.root.style.backgroundColor = theme.background;
      this.root.style.color = theme.foreground;
    }

    if (this.screen) {
      this.screen.style.backgroundColor = theme.background;
    }
  }

  measureCellDimensions(): void {
    if (!this.root) {
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

    this.root.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();

    // CSS cell 对齐到物理像素网格（与 CanvasRenderer 的整数设备像素 cell 一致），
    // 否则小数 cell 会让布局（cols/rows、hit-test）与渲染网格逐格漂移。
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const rawWidth = rect.width > 0 ? rect.width / 10 : DEFAULT_CELL_WIDTH;
    // cell 高确定式计算 = fontSize × lineHeight，规范唯一确定，enforce 跨平台一致。
    const rawHeight = this.options.fontSize * (this.options.lineHeight ?? LINE_HEIGHT);
    this.cell.width = Math.max(1, Math.round(rawWidth * dpr)) / dpr;
    this.cell.height = Math.max(1, Math.round(rawHeight * dpr)) / dpr;
    this.invalidateLayoutMetrics();
  }

  measureSize(): GhosttyTerminalSize | null {
    if (!this.root) {
      return null;
    }

    const rect = this.root.getBoundingClientRect();
    const { width, height } = this.cell;
    if (rect.width === 0 || rect.height === 0 || width <= 0 || height <= 0) {
      return null;
    }

    return {
      cols: Math.max(2, Math.floor(rect.width / width)),
      rows: Math.max(2, Math.floor(rect.height / height)),
    };
  }

  // 一次滚轮手势要按行编码 N 次鼠标上报，每次都要 rect：走缓存，只在布局失效或
  // TTL 到期后重新量一次，避免与同帧的样式写构成强制同步布局。
  screenBounds(): TerminalScreenRect | null {
    return this.screenRect.read(this.screen);
  }

  // 绕过缓存实测一次并刷新缓存：调用方紧跟在一次不发任何事件的布局变化之后（键盘
  // 避让给 <main> 写 transform），正确性优先于那一次强制布局。
  measureScreenBounds(): TerminalScreenRect | null {
    this.screenRect.invalidate();
    return this.screenRect.read(this.screen);
  }

  syncInputState(disableStdin: boolean): void {
    const textarea = this.helperTextarea;
    if (!textarea) {
      return;
    }

    (textarea as unknown as { readOnly: boolean }).readOnly = disableStdin;
    textarea.tabIndex = disableStdin ? -1 : 0;
    if (disableStdin && document.activeElement === textarea) {
      textarea.blur();
    }
  }

  focusTextarea(): void {
    this.helperTextarea?.focus({ preventScroll: true });
  }

  isTextareaFocused(): boolean {
    return this.helperTextarea !== null && document.activeElement === this.helperTextarea;
  }

  // 每次击键都会调用：contenteditable 子树即使写入同样的空串也会失效布局，
  // 而紧随其后的 positionTextareaAtCursor 要读几何，所以已经空就不写。
  clearTextarea(): void {
    if (this.helperTextarea && this.helperTextarea.textContent !== '') {
      this.helperTextarea.textContent = '';
    }
  }

  // 把 helper textarea 贴到光标所在 cell，IME 候选框才会跟随光标弹出。
  positionTextareaAtCursor(cursorX: number, cursorY: number): void {
    const textarea = this.helperTextarea;
    const { width, height } = this.cell;
    if (!textarea || !this.screen || width <= 0 || height <= 0) {
      return;
    }

    this.cursorCell = { x: cursorX, y: cursorY };
    // textarea 是 root 的子节点（不随内容表面平移），pan 开启时要手动扣掉滚动偏移。
    const panLeft = this.panEnabled ? (this.viewport?.scrollLeft ?? 0) : 0;
    const panTop = this.panEnabled ? (this.viewport?.scrollTop ?? 0) : 0;
    textarea.style.left = `${cursorX * width - panLeft}px`;
    textarea.style.top = `${cursorY * height - panTop}px`;
    textarea.style.width = `${Math.max(1, width)}px`;
    textarea.style.height = `${Math.max(1, height)}px`;
    textarea.style.lineHeight = `${height}px`;
    textarea.style.fontFamily = this.options.fontFamily;
    textarea.style.fontSize = `${this.options.fontSize}px`;
  }

  updateScrollbar(scrollbar: TerminalScrollbarState): void {
    if (!this.scrollbarThumb) {
      return;
    }

    // 轨道贴在容器右缘，量的必须是可视高度：pan 开启后 .xterm-screen 是超尺寸内容表面，
    // 只有 .xterm-viewport 仍等于容器（pan 关闭时两者恒等，行为不变）。
    const trackHeight = this.readTrackHeight();
    if (trackHeight === 0 || scrollbar.total <= scrollbar.len) {
      this.writeThumbOpacity('0');
      return;
    }

    const ratio = scrollbar.len / scrollbar.total;
    const thumbHeight = Math.max(20, ratio * trackHeight);
    const scrollRatio = scrollbar.offset / Math.max(1, scrollbar.total - scrollbar.len);
    const thumbTop = scrollRatio * (trackHeight - thumbHeight);

    this.writeThumbGeometry(`${thumbHeight}px`, `translateY(${thumbTop}px)`);
    this.writeThumbOpacity(this.scrollbarVisible ? '1' : '0');
  }

  private writeThumbGeometry(height: string, transform: string): void {
    const thumb = this.scrollbarThumb;
    if (!thumb) {
      return;
    }

    if (this.lastThumbHeight !== height) {
      this.lastThumbHeight = height;
      thumb.style.height = height;
    }
    if (this.lastThumbTransform !== transform) {
      this.lastThumbTransform = transform;
      thumb.style.transform = transform;
    }
  }

  private writeThumbOpacity(opacity: string): void {
    const thumb = this.scrollbarThumb;
    if (!thumb || this.lastThumbOpacity === opacity) {
      return;
    }

    this.lastThumbOpacity = opacity;
    thumb.style.opacity = opacity;
  }

  // 悬停会以刷新率调用（120Hz 即每秒 120 次）：滚动条已可见时只推后到期时间戳，
  // 不重写样式、也不销毁重建定时器；定时器到点自己看 deadline 决定隐藏还是续期。
  showScrollbarTransient(): void {
    if (!this.focused || !this.scrollbarThumb) {
      return;
    }

    this.scrollbarFadeDeadline = monotonicNow() + SCROLLBAR_FADE_MS;
    if (this.scrollbarVisible && this.scrollbarFadeTimer !== null) {
      return;
    }

    this.scrollbarVisible = true;
    this.writeThumbOpacity('1');
    this.armScrollbarFade(SCROLLBAR_FADE_MS);
  }

  private armScrollbarFade(delay: number): void {
    this.scrollbarFadeTimer = setTimeout(() => {
      this.scrollbarFadeTimer = null;
      const remaining = this.scrollbarFadeDeadline - monotonicNow();
      if (remaining > 0) {
        this.armScrollbarFade(remaining);
        return;
      }

      this.scrollbarVisible = false;
      this.writeThumbOpacity('0');
    }, delay);
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    if (focused) {
      return;
    }

    this.scrollbarVisible = false;
    this.writeThumbOpacity('0');
    this.cancelScrollbarFade();
  }

  cancelScrollbarFade(): void {
    this.scrollbarFadeDeadline = 0;
    if (!this.scrollbarFadeTimer) {
      return;
    }

    clearTimeout(this.scrollbarFadeTimer);
    this.scrollbarFadeTimer = null;
  }

  setLinkCursor(active: boolean): void {
    if (this.linkCursorActive === active) {
      return;
    }
    this.linkCursorActive = active;
    if (this.screen) {
      this.screen.style.cursor = active ? 'pointer' : '';
    }
  }

  dispose(): void {
    this.screenRect.releaseGlobalLayout();
    this.viewport?.removeEventListener('scroll', this.handlePanScroll);
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.invalidateLayoutMetrics();
    this.root?.remove();
    this.root = null;
    this.viewport = null;
    this.screen = null;
    this.helperTextarea = null;
    this.scrollbarThumb = null;
    this.cursorCell = null;
  }
}
