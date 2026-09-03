import { drawBlockElement, drawCellDecorations } from './canvas-block-elements';
import {
  CellStyleResolver,
  blockElementCodepoint,
  cellBackgroundColor,
  hasDecorations,
  hasVisibleGlyph,
  isSpacerCell,
} from './canvas-cell-style';
import {
  expandNeighborRows,
  resolveEffectiveDirty,
  shouldDrawAllRows,
  wantsScrollBlit,
} from './canvas-renderer-draw-plan';
import {
  canvasSurfaceUnchanged,
  measureMaxTextRun,
  sameSelectionRects,
  toDeviceCell,
} from './canvas-renderer-metrics';
import { CursorLayer } from './cursor-layer';
import type {
  GhosttyCellDimensions,
  GhosttyRenderCell,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
  GhosttySelectionRect,
  GhosttyTheme,
} from './types';

type CanvasRendererOptions = {
  screenElement: HTMLElement;
  theme: GhosttyTheme;
  fontFamily: string;
  fontSize: number;
  /** 四张 canvas 的 CSS 尺寸变化后回调（cols×cellW / rows×cellH），供平移内容表面同步。 */
  onSurfaceSize?: (width: number, height: number) => void;
};

type CanvasRendererFrame = {
  meta: GhosttyRenderSnapshotMeta;
  rows: GhosttyRenderRow[];
  cellDimensions: GhosttyCellDimensions;
  selectionRects?: GhosttySelectionRect[];
  selectionColor?: string;
  // canvas 在上次 render 后被 resize 清空了位图（HTML5 canvas.width 赋值副作用），
  // 或 terminal 显式请求全画（forceFullRepaint）：两种情形都必须忽略 dirty='clean'
  // 早退、强制按 'full' 重画所有行，否则屏幕空白（issue #45 bug 3）。
  forceFull?: boolean;
  // 本帧的光标状态是否「落定」。false = 这一帧是被输出字节触发的，可能落在应用一次
  // 整屏重绘的中途，此刻的光标位置只是笔尖所在（刚写完的那个字符后面那一格），不是
  // 应用这一帧的最终落点。此时只把光标状态挂起，等 commitCursor() 在输出静默的那一帧
  // 落笔。缺省（undefined）视为已落定，保持非输出触发路径（主题/尺寸/滚动）的原语义。
  cursorSettled?: boolean;
  scrollDelta?: number;
};

type CanvasRendererDebugState = {
  kind: 'canvas';
  frameCount: number;
  lastDrawnRows: number[];
};

type LinkUnderlineSegment = {
  /** 视口内行号（0 起） */
  row: number;
  startCol: number;
  endCol: number;
};

function ensureContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2d canvas context unavailable');
  }

  return context;
}

type ScratchSurface = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };

// blitRows 的 ping-pong 中转画布：全尺寸位图（iPhone DPR3 下每张 ~10 MB），而 blit 在
// 一帧内同步完成、不会重入，所以整个模块共用一张即可 —— 保活多个终端时省下 N−1 张。
// 交换后「让位」的旧主画布随即成为新的共享中转，池里始终至多一张。
let sharedScratch: ScratchSurface | null = null;
let liveRenderers = 0;

function parkScratchSurface(surface: ScratchSurface): void {
  sharedScratch = surface;
}

// owner 是本实例主画布所属的 document：跨 document 的位图不能共用。
function acquireScratchSurface(owner: Document): ScratchSurface {
  if (sharedScratch && sharedScratch.canvas.ownerDocument === owner) {
    return sharedScratch;
  }

  dropSharedScratch();
  const canvas = document.createElement('canvas');
  canvas.dataset.layer = 'scratch';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.opacity = '0';
  const surface = { canvas, context: ensureContext(canvas) };
  parkScratchSurface(surface);
  return surface;
}

function dropSharedScratch(): void {
  if (sharedScratch) {
    sharedScratch.canvas.remove();
    sharedScratch.canvas.width = 0;
    sharedScratch.canvas.height = 0;
  }
  sharedScratch = null;
}

export class CanvasRenderer {
  readonly kind = 'canvas';

  private mainCanvas: HTMLCanvasElement;
  private readonly linkCanvas: HTMLCanvasElement;
  private readonly selectionCanvas: HTMLCanvasElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private mainContext: CanvasRenderingContext2D;
  private readonly linkContext: CanvasRenderingContext2D;
  private readonly selectionContext: CanvasRenderingContext2D;
  private readonly cursorContext: CanvasRenderingContext2D;
  private theme: GhosttyTheme;
  private readonly fontSize: number;
  private cellDimensions: GhosttyCellDimensions = { width: 9, height: 17 };
  // 设备像素整数 cell。所有绘制坐标必须落在整数物理像素上：相邻 fillRect 在
  // 小数边界各自抗锯齿半覆盖，叠加后边界像素覆盖不满，会在大面积色块中透出
  // 底色形成横竖细线。
  private deviceCellWidth = 9;
  private deviceCellHeight = 17;
  // 字号（fontSize×dpr，用于 ctx.font），及由「真实字体度量」算出的垂直定位：
  // 用 em-box=fontSize 当字形盒会忽略实际 ascent/descent，降部溢出 cell 被逐行 clearRect
  // 擦掉（f/y/g 掐尾）。改用 measureText 的 fontBoundingBox 把字形盒在 cell 内垂直居中。
  // 三者随 cell/dpr 在 resize() 内一并刷新。
  private deviceFontSize = 13;
  private textTopGap = 0; // 字形盒顶到 cell 顶的间距
  private textBaselineY = 0; // alphabetic baseline 相对 cell 顶的 y
  private glyphBoxHeight = 0; // 字形盒高 = ascent + descent
  private dpr = 1;
  private cols = 0;
  private rows = 0;
  private frameCount = 0;
  private lastDrawnRows: number[] = [];
  private readonly cellStyle: CellStyleResolver;
  private maxTextRun = 1;
  private assignedMainFillStyle: string | null = null;
  private assignedMainFont: string | null = null;
  // 上一帧的完整输入：拖拽期间 dpr/cell 变化时用它整帧重画（见 drawSelectionOnly）。
  private lastFrame: CanvasRendererFrame | null = null;
  private drawnSelectionRects: GhosttySelectionRect[] = [];
  private drawnSelectionColor = '';
  private readonly cursorLayer: CursorLayer;
  private readonly onSurfaceSize: ((width: number, height: number) => void) | null;
  private disposed = false;

  constructor(options: CanvasRendererOptions) {
    this.onSurfaceSize = options.onSurfaceSize ?? null;
    this.theme = options.theme;
    this.fontSize = options.fontSize;
    this.cellStyle = new CellStyleResolver(options.fontFamily);
    liveRenderers += 1;

    options.screenElement.style.position = 'relative';
    options.screenElement.style.overflow = 'hidden';

    this.mainCanvas = document.createElement('canvas');
    this.linkCanvas = document.createElement('canvas');
    this.selectionCanvas = document.createElement('canvas');
    this.cursorCanvas = document.createElement('canvas');

    for (const [canvas, layer] of [
      [this.mainCanvas, 'main'],
      [this.linkCanvas, 'link'],
      [this.selectionCanvas, 'selection'],
      [this.cursorCanvas, 'cursor'],
    ] as const) {
      canvas.dataset.layer = layer;
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      options.screenElement.appendChild(canvas);
    }

    this.mainContext = ensureContext(this.mainCanvas);
    this.linkContext = ensureContext(this.linkCanvas);
    this.selectionContext = ensureContext(this.selectionCanvas);
    this.cursorContext = ensureContext(this.cursorCanvas);
    this.cursorLayer = new CursorLayer(this.cursorCanvas, this.cursorContext);
  }

  setTheme(theme: GhosttyTheme): void {
    this.theme = theme;
    this.cellStyle.clearColors();
  }

  render(frame: CanvasRendererFrame): void {
    this.lastFrame = frame;
    this.frameCount += 1;
    this.lastDrawnRows = [];
    this.cellDimensions = frame.cellDimensions;
    const wiped = this.resize(frame.meta.cols, frame.meta.rows);
    this.drawSelection(
      frame.selectionRects ?? [],
      frame.selectionColor ?? this.theme.selectionBackground,
      wiped
    );

    // canvas 位图被 resize 清空 / 外部强制全画 → 必须忽略 dirty='clean' 早退，
    // 否则屏幕空白（issue #45 bug 3）。
    const effectiveDirty = resolveEffectiveDirty(wiped, frame.forceFull, frame.meta.dirty);

    if (effectiveDirty === 'clean') {
      this.updateCursor(frame, wiped);
      return;
    }

    const scrollDelta = frame.scrollDelta ?? 0;
    const wantsBlit = wantsScrollBlit(effectiveDirty, scrollDelta, this.rows);
    const scrollBlitted = wantsBlit ? this.blitRows(scrollDelta) : false;
    const drawAllRows = shouldDrawAllRows(effectiveDirty, wantsBlit, scrollBlitted);
    const dirtyRows = drawAllRows ? frame.rows : frame.rows.filter((row) => row.dirty);

    // 允许字形垂直溢出相邻 cell——兼容带高升部/深降部的「奇怪」Unicode（组合记号、Zalgo、
    // 部分非拉丁文字），它们的墨迹可超出字体度量盒乃至 cell。两点保障：
    // 1) 重绘集扩到脏行上下邻行（±1），邻行溢入本行的墨迹随之恢复；
    // 2) 分两遍——先铺所有目标行背景、再画所有目标行前景。不透明背景全部先于字形落地，
    //    相邻 cell 背景便不会擦掉溢出的字形墨迹。
    // lastDrawnRows 仍只记真正脏的行（邻行重绘属实现细节）。
    const renderRows = expandNeighborRows(frame.rows, dirtyRows, drawAllRows);

    for (const row of renderRows) {
      this.drawRowBackground(row, frame.meta.colors);
    }
    for (const row of renderRows) {
      this.drawRowForeground(row, frame.meta.colors);
    }

    for (const row of dirtyRows) {
      this.lastDrawnRows.push(row.y);
    }

    this.updateCursor(frame, wiped);
  }

  // 把上一帧挂起的光标状态落笔。由渲染协调器在「距上一次输出已过一帧、流已静默」
  // 时调用：此刻 WASM 里的光标就是应用这一帧的最终落点。
  commitCursor(): void {
    this.noteVacatedRow(this.cursorLayer.commit());
  }

  getDebugState(): CanvasRendererDebugState {
    return {
      kind: this.kind,
      frameCount: this.frameCount,
      lastDrawnRows: [...this.lastDrawnRows],
    };
  }

  dispose(): void {
    this.releaseScratch();
    this.mainCanvas.remove();
    this.linkCanvas.remove();
    this.selectionCanvas.remove();
    this.cursorCanvas.remove();
    this.cellStyle.dispose();
    this.assignedMainFillStyle = null;
    this.assignedMainFont = null;
    this.drawnSelectionRects = [];
    this.lastFrame = null;
    this.cursorLayer.dispose();
  }

  // 共享中转画布可能正停在本实例的层栈里：先摘出来；本实例是最后一个时整张释放。
  private releaseScratch(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const parent = this.mainCanvas.parentElement;
    if (sharedScratch && parent && sharedScratch.canvas.parentElement === parent) {
      sharedScratch.canvas.remove();
    }
    liveRenderers = Math.max(0, liveRenderers - 1);
    if (liveRenderers === 0) {
      dropSharedScratch();
    }
  }

  // 返回 true 表示触发了 canvas.width/height 赋值（HTML5 标准会 wipe 已绘位图），
  // 调用方需把 dirty 视作 'full' 强制全画以避免空白屏（issue #45 bug 3）。
  private resize(cols: number, rows: number): boolean {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const deviceCellWidth = toDeviceCell(this.cellDimensions.width, dpr);
    const deviceCellHeight = toDeviceCell(this.cellDimensions.height, dpr);

    if (
      canvasSurfaceUnchanged(
        {
          cols: this.cols,
          rows: this.rows,
          dpr: this.dpr,
          deviceCellWidth: this.deviceCellWidth,
          deviceCellHeight: this.deviceCellHeight,
          canvasWidth: this.mainCanvas.width,
          canvasHeight: this.mainCanvas.height,
        },
        { cols: nextCols, rows: nextRows, dpr, deviceCellWidth, deviceCellHeight }
      )
    ) {
      return false;
    }

    this.cols = nextCols;
    this.rows = nextRows;
    this.dpr = dpr;
    this.deviceCellWidth = deviceCellWidth;
    this.deviceCellHeight = deviceCellHeight;
    this.deviceFontSize = this.fontSize * dpr;
    this.cursorLayer.setMetrics(deviceCellWidth, deviceCellHeight, dpr);
    this.cellStyle.resetFonts(this.deviceFontSize);
    // 量真实字体度量（含升/降部的字形盒），把字形盒整体在 cell 内垂直居中。
    // baseline 用 alphabetic：盒高 ≤ cell 时 [topGap, topGap+ascent+descent] ⊆ [0, cellH]，
    // 升降部都不溢出，且用本引擎自报度量，跨平台自洽。
    this.mainContext.font = this.cellStyle.regularFont();
    const metrics = this.mainContext.measureText('Mg|qyÅ');
    this.maxTextRun = measureMaxTextRun(
      (text) => this.mainContext.measureText(text).width,
      nextCols,
      deviceCellWidth
    );
    let ascent = metrics.fontBoundingBoxAscent;
    let descent = metrics.fontBoundingBoxDescent;
    if (!(Number.isFinite(ascent) && Number.isFinite(descent) && ascent > 0)) {
      // 极少数环境无 fontBoundingBox：按典型 0.8/0.2 em 兜底，仍优于贴顶。
      ascent = this.deviceFontSize * 0.8;
      descent = this.deviceFontSize * 0.2;
    }
    this.glyphBoxHeight = ascent + descent;
    this.textTopGap = Math.round((deviceCellHeight - this.glyphBoxHeight) / 2);
    this.textBaselineY = Math.round(this.textTopGap + ascent);

    const width = nextCols * deviceCellWidth;
    const height = nextRows * deviceCellHeight;

    const cssWidth = width / dpr;
    const cssHeight = height / dpr;
    for (const canvas of [
      this.mainCanvas,
      this.linkCanvas,
      this.selectionCanvas,
      this.cursorCanvas,
    ]) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    this.onSurfaceSize?.(cssWidth, cssHeight);

    for (const context of [
      this.mainContext,
      this.linkContext,
      this.selectionContext,
      this.cursorContext,
    ]) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      // alphabetic：按真实 baseline 定位，配合 textBaselineY 精确居中字形盒。
      context.textBaseline = 'alphabetic';
      context.imageSmoothingEnabled = false;
    }
    this.assignedMainFillStyle = null;
    this.assignedMainFont = null;

    return true;
  }

  // 链接虚线下划线层：独立 canvas，与主画布的按行局部重绘互不干扰。
  // 每次全量重画（段数少、开销可忽略），由 terminal 侧节流调用。
  drawLinkUnderlines(segments: LinkUnderlineSegment[]): void {
    const context = this.linkContext;
    context.clearRect(0, 0, this.linkCanvas.width, this.linkCanvas.height);
    if (segments.length === 0) {
      return;
    }

    const thickness = Math.max(1, Math.round(this.dpr));
    const dash = Math.max(2, Math.round(2 * this.dpr));
    // 奇数线宽时偏移 0.5 物理像素，避免 1px 线被抗锯齿糊成 2px。
    const crisp = thickness % 2 === 1 ? 0.5 : 0;

    context.strokeStyle = this.theme.foreground;
    context.globalAlpha = 0.55;
    context.lineWidth = thickness;
    context.setLineDash([dash, dash]);
    context.beginPath();
    for (const segment of segments) {
      const cellTop = segment.row * this.deviceCellHeight;
      const y =
        Math.min(
          Math.round(cellTop + this.textTopGap + this.glyphBoxHeight - thickness),
          cellTop + this.deviceCellHeight - thickness
        ) + crisp;
      const x0 = segment.startCol * this.deviceCellWidth;
      const x1 = (segment.endCol + 1) * this.deviceCellWidth;
      context.moveTo(x0, y);
      context.lineTo(x1, y);
    }
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }

  clearLinkUnderlines(): void {
    this.linkContext.clearRect(0, 0, this.linkCanvas.width, this.linkCanvas.height);
  }

  // 只重画选区层：拖拽期间的唯一变化就是选区矩形，主画布/光标层一个像素都不用碰。
  // 例外：拖拽期间 dpr / cell 尺寸可能已变（浏览器缩放、换屏），而网格未变时不会有新帧
  // 进来，此时位图尺寸整体过期，只补选区层会按旧网格落笔——退回用上一帧数据整帧重画。
  drawSelectionOnly(rects: GhosttySelectionRect[], color: string): void {
    const frame = this.lastFrame;
    if (frame && this.layoutStale()) {
      // 网格已换算，挂起的光标状态也按新几何立刻落笔，否则光标停在旧网格的坐标上。
      this.render({
        ...frame,
        selectionRects: rects,
        selectionColor: color,
        forceFull: true,
        cursorSettled: true,
      });
      return;
    }

    this.drawSelection(rects, color, false);
  }

  private layoutStale(): boolean {
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    return (
      this.dpr !== dpr ||
      this.deviceCellWidth !== toDeviceCell(this.cellDimensions.width, dpr) ||
      this.deviceCellHeight !== toDeviceCell(this.cellDimensions.height, dpr) ||
      this.mainCanvas.width !== this.cols * this.deviceCellWidth ||
      this.mainCanvas.height !== this.rows * this.deviceCellHeight
    );
  }

  // 选区层与主画布的按行重绘互不相干：只在选区矩形集、选区色或画布尺寸变化时重画，
  // 没有选区的常态帧（绝大多数）完全不碰这一层。
  private drawSelection(rects: GhosttySelectionRect[], color: string, wiped: boolean): void {
    if (
      !wiped &&
      color === this.drawnSelectionColor &&
      sameSelectionRects(rects, this.drawnSelectionRects)
    ) {
      return;
    }

    this.drawnSelectionRects = rects.map((rect) => ({ ...rect }));
    this.drawnSelectionColor = color;
    this.selectionContext.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);

    if (rects.length === 0) {
      return;
    }

    this.selectionContext.fillStyle = color;
    for (const rect of rects) {
      this.selectionContext.fillRect(
        rect.x * this.deviceCellWidth,
        rect.row * this.deviceCellHeight,
        rect.width * this.deviceCellWidth,
        this.deviceCellHeight
      );
    }
  }

  // 背景遍：清本行带、铺默认底色、逐 cell 铺非默认底色。不画任何字形。
  private drawRowBackground(
    row: GhosttyRenderRow,
    colors: GhosttyRenderSnapshotMeta['colors']
  ): void {
    const y = row.y * this.deviceCellHeight;
    const width = this.cols * this.deviceCellWidth;
    const defaultBackground = this.cellStyle.toCss(colors.background);

    this.mainContext.clearRect(0, y, width, this.deviceCellHeight);
    this.setMainFillStyle(defaultBackground);
    this.mainContext.fillRect(0, y, width, this.deviceCellHeight);

    for (let index = 0; index < row.cells.length; index += 1) {
      const cell = row.cells[index];
      if (isSpacerCell(cell)) {
        continue;
      }

      const bg = cellBackgroundColor(cell, colors);
      if (
        bg.r !== colors.background.r ||
        bg.g !== colors.background.g ||
        bg.b !== colors.background.b
      ) {
        const css = this.cellStyle.toCss(bg);
        if (this.canBatchBackground(cell)) {
          let end = index + 1;
          while (end < row.cells.length) {
            const next = row.cells[end];
            if (
              !this.canBatchBackground(next) ||
              next.x !== cell.x + (end - index) ||
              this.cellStyle.toCss(cellBackgroundColor(next, colors)) !== css
            ) {
              break;
            }
            end += 1;
          }
          this.setMainFillStyle(css);
          this.mainContext.fillRect(
            cell.x * this.deviceCellWidth,
            y,
            (end - index) * this.deviceCellWidth,
            this.deviceCellHeight
          );
          index = end - 1;
        } else {
          this.setMainFillStyle(css);
          this.mainContext.fillRect(
            cell.x * this.deviceCellWidth,
            y,
            this.cellDeviceWidth(cell),
            this.deviceCellHeight
          );
        }
      }
    }
  }

  private cellDeviceWidth(cell: GhosttyRenderCell): number {
    return cell.widthKind === 'wide' ? this.deviceCellWidth * 2 : this.deviceCellWidth;
  }

  private canBatchBackground(cell: GhosttyRenderCell): boolean {
    return (
      cell.widthKind === 'narrow' && blockElementCodepoint(cell) < 0 && !hasDecorations(cell.style)
    );
  }

  private canBatchGlyph(cell: GhosttyRenderCell): boolean {
    return !cell.style.invisible && this.canBatchBackground(cell);
  }

  // 前景遍：逐 cell 画字形/块元素/装饰线。在所有行背景铺完后调用，故字形可越界相邻 cell
  // 而不被邻 cell 的不透明背景擦掉（允许「奇怪」Unicode 的升/降部溢出）。
  private drawRowForeground(
    row: GhosttyRenderRow,
    colors: GhosttyRenderSnapshotMeta['colors']
  ): void {
    const y = row.y * this.deviceCellHeight;
    const lineThickness = Math.max(1, Math.round(this.dpr));

    for (let index = 0; index < row.cells.length; index += 1) {
      const cell = row.cells[index];
      if (!hasVisibleGlyph(cell)) {
        continue;
      }

      const x = cell.x * this.deviceCellWidth;
      const cellWidth = this.cellDeviceWidth(cell);

      const fillStyle = this.cellStyle.foregroundCss(cell, colors);
      if (this.canBatchGlyph(cell)) {
        const font = this.cellStyle.resolveFont(cell.style);
        let text = cell.text;
        let end = index + 1;
        while (end < row.cells.length) {
          const next = row.cells[end];
          if (
            end - index >= this.maxTextRun ||
            !this.canBatchGlyph(next) ||
            next.x !== cell.x + (end - index) ||
            this.cellStyle.foregroundCss(next, colors) !== fillStyle ||
            this.cellStyle.resolveFont(next.style) !== font
          ) {
            break;
          }
          text += next.text || ' ';
          end += 1;
        }
        this.setMainFillStyle(fillStyle);
        this.setMainFont(font);
        this.mainContext.fillText(text, x, y + this.textBaselineY);
        index = end - 1;
        continue;
      }

      this.setMainFillStyle(fillStyle);
      this.drawCellGlyph(cell, x, y, cellWidth);
      drawCellDecorations(this.mainContext, cell.style, x, y, cellWidth, {
        cellHeight: this.deviceCellHeight,
        textTopGap: this.textTopGap,
        glyphBoxHeight: this.glyphBoxHeight,
        lineThickness,
      });
    }
  }

  // fillStyle 由调用方设好。块元素（▀▄█▌▐░▒▓ 等）不能交给字体：字形最多覆盖 1em，
  // 而 cell 高为 1.2em，行列间会留缝（logo/色块图中的明显间隙），必须按 cell 精确自绘。
  private drawCellGlyph(cell: GhosttyRenderCell, x: number, y: number, cellWidth: number): void {
    const blockCodepoint = blockElementCodepoint(cell);
    if (blockCodepoint >= 0) {
      drawBlockElement(this.mainContext, blockCodepoint, x, y, cellWidth, this.deviceCellHeight);
      return;
    }

    this.setMainFont(this.cellStyle.resolveFont(cell.style));
    this.mainContext.fillText(cell.text, x, y + this.textBaselineY);
  }

  // 光标层的每帧入口：解析光标色后交给 CursorLayer（落定语义见该模块注释）。
  // 光标色取自 ghostty render state（colors.cursor 缺省时回落到 colors.foreground），
  // 不读 this.theme——主题切换由 WASM 侧 setTerminalTheme 反映到 render state。
  private updateCursor(frame: CanvasRendererFrame, wiped: boolean): void {
    const cssColor = this.cellStyle.toCss(frame.meta.colors.cursor ?? frame.meta.colors.foreground);
    this.noteVacatedRow(
      this.cursorLayer.update(frame.meta.cursor, cssColor, wiped, frame.cursorSettled !== false)
    );
  }

  // 光标离开的旧行要计入 lastDrawnRows，供调试/测试观察重绘范围。
  private noteVacatedRow(row: number | null): void {
    if (row !== null) {
      this.lastDrawnRows.push(row);
    }
  }

  private blitRows(scrollDelta: number): boolean {
    if (typeof this.mainContext.drawImage !== 'function') {
      return false;
    }

    const shiftedRows = Math.abs(scrollDelta);
    const retainedHeight = (this.rows - shiftedRows) * this.deviceCellHeight;
    if (retainedHeight <= 0) {
      return false;
    }

    const parent = this.mainCanvas.parentElement;
    if (!parent) {
      return false;
    }

    const scratch = acquireScratchSurface(this.mainCanvas.ownerDocument);
    const width = this.mainCanvas.width;
    if (scratch.canvas.width !== width || scratch.canvas.height !== this.mainCanvas.height) {
      scratch.canvas.width = width;
      scratch.canvas.height = this.mainCanvas.height;
    }
    if (scratch.canvas.parentElement !== parent) {
      parent.insertBefore(scratch.canvas, this.mainCanvas);
    }

    scratch.canvas.style.width = this.mainCanvas.style.width;
    scratch.canvas.style.height = this.mainCanvas.style.height;
    scratch.context.setTransform(1, 0, 0, 1, 0, 0);
    scratch.context.textBaseline = 'alphabetic';
    scratch.context.imageSmoothingEnabled = false;

    const sourceY = scrollDelta > 0 ? shiftedRows * this.deviceCellHeight : 0;
    const destinationY = scrollDelta > 0 ? 0 : shiftedRows * this.deviceCellHeight;
    scratch.context.globalCompositeOperation = 'copy';
    scratch.context.drawImage(
      this.mainCanvas,
      0,
      sourceY,
      width,
      retainedHeight,
      0,
      destinationY,
      width,
      retainedHeight
    );
    scratch.context.globalCompositeOperation = 'source-over';

    const previousCanvas = this.mainCanvas;
    const previousContext = this.mainContext;
    previousCanvas.dataset.layer = 'scratch';
    previousCanvas.style.opacity = '0';
    scratch.canvas.dataset.layer = 'main';
    scratch.canvas.style.opacity = '1';
    this.mainCanvas = scratch.canvas;
    this.mainContext = scratch.context;
    // 让位的旧主画布成为新的共享中转，池里始终只有一张全尺寸位图。
    parkScratchSurface({ canvas: previousCanvas, context: previousContext });
    this.assignedMainFillStyle = null;
    this.assignedMainFont = null;
    return true;
  }

  private setMainFillStyle(fillStyle: string): void {
    if (this.assignedMainFillStyle === fillStyle) {
      return;
    }
    this.mainContext.fillStyle = fillStyle;
    this.assignedMainFillStyle = fillStyle;
  }

  private setMainFont(font: string): void {
    if (this.assignedMainFont === font) {
      return;
    }
    this.mainContext.font = font;
    this.assignedMainFont = font;
  }
}

export type {
  CanvasRendererDebugState,
  CanvasRendererFrame,
  CanvasRendererOptions,
  LinkUnderlineSegment,
};
