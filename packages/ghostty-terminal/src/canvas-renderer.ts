import { CursorLayer } from './cursor-layer';
import type {
  GhosttyCellDimensions,
  GhosttyColorRgb,
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
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

function colorKey(color: GhosttyColorRgb): number {
  return (color.r << 16) | (color.g << 8) | color.b;
}

function fontVariantIndex(style: GhosttyRenderCellStyle): number {
  return (style.italic ? 1 : 0) | (style.bold ? 2 : 0);
}

function sameSelectionRects(
  left: readonly GhosttySelectionRect[],
  right: readonly GhosttySelectionRect[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.row !== b.row || a.x !== b.x || a.width !== b.width) {
      return false;
    }
  }

  return true;
}

function toDeviceCell(size: number, dpr: number): number {
  return Math.max(1, Math.round(size * dpr));
}

function colorToCss(color: GhosttyColorRgb): string {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

// U+2596–U+259F quadrant 块的象限组合：UL=1、UR=2、LL=4、LR=8
const QUADRANT_FLAGS = new Map<number, number>([
  [0x2596, 0b0100],
  [0x2597, 0b1000],
  [0x2598, 0b0001],
  [0x2599, 0b1101],
  [0x259a, 0b1001],
  [0x259b, 0b0111],
  [0x259c, 0b1011],
  [0x259d, 0b0010],
  [0x259e, 0b0110],
  [0x259f, 0b1110],
]);

const SHADE_ALPHA = new Map<number, number>([
  [0x2591, 0.25],
  [0x2592, 0.5],
  [0x2593, 0.75],
]);

function isBlockElement(codepoint: number): boolean {
  return codepoint >= 0x2580 && codepoint <= 0x259f;
}

function isSpacerCell(cell: GhosttyRenderCell): boolean {
  return cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head';
}

function hasVisibleGlyph(cell: GhosttyRenderCell): boolean {
  return !isSpacerCell(cell) && cell.text !== '' && !cell.style.invisible;
}

// inverse 时前后景互换；缺省色回落到快照的默认前/背景。返回的都是已有实例，不分配。
function cellForegroundColor(
  cell: GhosttyRenderCell,
  colors: GhosttyRenderSnapshotMeta['colors']
): GhosttyColorRgb {
  if (cell.style.inverse) {
    return cell.bgColor ?? colors.background;
  }

  return cell.fgColor ?? colors.foreground;
}

function cellBackgroundColor(
  cell: GhosttyRenderCell,
  colors: GhosttyRenderSnapshotMeta['colors']
): GhosttyColorRgb {
  if (cell.style.inverse) {
    return cell.fgColor ?? colors.foreground;
  }

  return cell.bgColor ?? colors.background;
}

// 只有「单码位且落在块元素区」的 cell 才自绘，其余交给字体。
function blockElementCodepoint(cell: GhosttyRenderCell): number {
  if (cell.codepoints.length !== 1) {
    return -1;
  }

  const codepoint = cell.codepoints[0];
  return isBlockElement(codepoint) ? codepoint : -1;
}

function ensureContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('2d canvas context unavailable');
  }

  return context;
}

export class CanvasRenderer {
  readonly kind = 'canvas';

  private readonly mainCanvas: HTMLCanvasElement;
  private readonly linkCanvas: HTMLCanvasElement;
  private readonly selectionCanvas: HTMLCanvasElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly mainContext: CanvasRenderingContext2D;
  private readonly linkContext: CanvasRenderingContext2D;
  private readonly selectionContext: CanvasRenderingContext2D;
  private readonly cursorContext: CanvasRenderingContext2D;
  private theme: GhosttyTheme;
  private readonly fontFamily: string;
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
  private readonly colorCache = new Map<number, string>();
  // 四种字形变体（regular / italic / bold / bold-italic），随 deviceFontSize 在 resize 内失效。
  private fontVariants: (string | null)[] = [null, null, null, null];
  // 上一帧的完整输入：拖拽期间 dpr/cell 变化时用它整帧重画（见 drawSelectionOnly）。
  private lastFrame: CanvasRendererFrame | null = null;
  private drawnSelectionRects: GhosttySelectionRect[] = [];
  private drawnSelectionColor = '';
  private readonly cursorLayer: CursorLayer;

  constructor(options: CanvasRendererOptions) {
    this.theme = options.theme;
    this.fontFamily = options.fontFamily;
    this.fontSize = options.fontSize;

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
    this.colorCache.clear();
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
    const effectiveDirty = wiped || frame.forceFull === true ? 'full' : frame.meta.dirty;

    if (effectiveDirty === 'clean') {
      this.updateCursor(frame, wiped);
      return;
    }

    const drawAllRows = effectiveDirty === 'full';
    const dirtyRows = drawAllRows ? frame.rows : frame.rows.filter((row) => row.dirty);

    // 允许字形垂直溢出相邻 cell——兼容带高升部/深降部的「奇怪」Unicode（组合记号、Zalgo、
    // 部分非拉丁文字），它们的墨迹可超出字体度量盒乃至 cell。两点保障：
    // 1) 重绘集扩到脏行上下邻行（±1），邻行溢入本行的墨迹随之恢复；
    // 2) 分两遍——先铺所有目标行背景、再画所有目标行前景。不透明背景全部先于字形落地，
    //    相邻 cell 背景便不会擦掉溢出的字形墨迹。
    // lastDrawnRows 仍只记真正脏的行（邻行重绘属实现细节）。
    let renderRows: GhosttyRenderRow[];
    if (drawAllRows) {
      renderRows = frame.rows;
    } else {
      const ys = new Set<number>();
      for (const row of dirtyRows) {
        ys.add(row.y - 1);
        ys.add(row.y);
        ys.add(row.y + 1);
      }
      renderRows = frame.rows.filter((row) => ys.has(row.y));
    }

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
    this.mainCanvas.remove();
    this.linkCanvas.remove();
    this.selectionCanvas.remove();
    this.cursorCanvas.remove();
    this.colorCache.clear();
    this.fontVariants = [null, null, null, null];
    this.drawnSelectionRects = [];
    this.lastFrame = null;
    this.cursorLayer.dispose();
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
      this.cols === nextCols &&
      this.rows === nextRows &&
      this.dpr === dpr &&
      this.deviceCellWidth === deviceCellWidth &&
      this.deviceCellHeight === deviceCellHeight &&
      // 位图属性被外部改写/浏览器重置时（内容已清空），缓存几何不可信，必须走全量重建
      this.mainCanvas.width === nextCols * deviceCellWidth &&
      this.mainCanvas.height === nextRows * deviceCellHeight
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
    this.fontVariants = [null, null, null, null];
    // 量真实字体度量（含升/降部的字形盒），把字形盒整体在 cell 内垂直居中。
    // baseline 用 alphabetic：盒高 ≤ cell 时 [topGap, topGap+ascent+descent] ⊆ [0, cellH]，
    // 升降部都不溢出，且用本引擎自报度量，跨平台自洽。
    this.mainContext.font = `${this.deviceFontSize}px ${this.fontFamily}`;
    const metrics = this.mainContext.measureText('Mg|qyÅ');
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

    for (const canvas of [
      this.mainCanvas,
      this.linkCanvas,
      this.selectionCanvas,
      this.cursorCanvas,
    ]) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width / dpr}px`;
      canvas.style.height = `${height / dpr}px`;
    }

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
    const defaultBackground = this.toCss(colors.background);

    this.mainContext.clearRect(0, y, width, this.deviceCellHeight);
    this.mainContext.fillStyle = defaultBackground;
    this.mainContext.fillRect(0, y, width, this.deviceCellHeight);

    for (const cell of row.cells) {
      if (isSpacerCell(cell)) {
        continue;
      }

      const bg = cellBackgroundColor(cell, colors);
      if (
        bg.r !== colors.background.r ||
        bg.g !== colors.background.g ||
        bg.b !== colors.background.b
      ) {
        this.mainContext.fillStyle = this.toCss(bg);
        this.mainContext.fillRect(
          cell.x * this.deviceCellWidth,
          y,
          this.cellDeviceWidth(cell),
          this.deviceCellHeight
        );
      }
    }
  }

  private cellDeviceWidth(cell: GhosttyRenderCell): number {
    return cell.widthKind === 'wide' ? this.deviceCellWidth * 2 : this.deviceCellWidth;
  }

  // 前景遍：逐 cell 画字形/块元素/装饰线。在所有行背景铺完后调用，故字形可越界相邻 cell
  // 而不被邻 cell 的不透明背景擦掉（允许「奇怪」Unicode 的升/降部溢出）。
  private drawRowForeground(
    row: GhosttyRenderRow,
    colors: GhosttyRenderSnapshotMeta['colors']
  ): void {
    const y = row.y * this.deviceCellHeight;
    const lineThickness = Math.max(1, Math.round(this.dpr));

    for (const cell of row.cells) {
      if (!hasVisibleGlyph(cell)) {
        continue;
      }

      const x = cell.x * this.deviceCellWidth;
      const cellWidth = this.cellDeviceWidth(cell);

      this.mainContext.fillStyle = this.toCss(cellForegroundColor(cell, colors));
      this.drawCellGlyph(cell, x, y, cellWidth);
      this.drawCellDecorations(cell.style, x, y, cellWidth, lineThickness);
    }
  }

  // fillStyle 由调用方设好。块元素（▀▄█▌▐░▒▓ 等）不能交给字体：字形最多覆盖 1em，
  // 而 cell 高为 1.2em，行列间会留缝（logo/色块图中的明显间隙），必须按 cell 精确自绘。
  private drawCellGlyph(cell: GhosttyRenderCell, x: number, y: number, cellWidth: number): void {
    const blockCodepoint = blockElementCodepoint(cell);
    if (blockCodepoint >= 0) {
      this.drawBlockElement(blockCodepoint, x, y, cellWidth, this.deviceCellHeight);
      return;
    }

    this.mainContext.font = this.resolveFont(cell.style);
    this.mainContext.fillText(cell.text, x, y + this.textBaselineY);
  }

  // 装饰线随真实字形盒走，而非 cell 边缘：下划线贴字底、上划线贴字顶、
  // 删除线穿字形几何中线。fillStyle 由调用方设好。
  private drawCellDecorations(
    style: GhosttyRenderCellStyle,
    x: number,
    y: number,
    cellWidth: number,
    lineThickness: number
  ): void {
    const lineWidth = Math.max(cellWidth - lineThickness, lineThickness);

    if (style.underline > 0) {
      const glyphBottom = y + this.textTopGap + this.glyphBoxHeight;
      this.mainContext.fillRect(
        x,
        Math.min(
          Math.round(glyphBottom - lineThickness),
          y + this.deviceCellHeight - lineThickness
        ),
        lineWidth,
        lineThickness
      );
    }

    if (style.strikethrough) {
      this.mainContext.fillRect(
        x,
        Math.round(y + this.textTopGap + this.glyphBoxHeight / 2),
        lineWidth,
        lineThickness
      );
    }

    if (style.overline) {
      this.mainContext.fillRect(
        x,
        Math.max(y, Math.round(y + this.textTopGap)),
        lineWidth,
        lineThickness
      );
    }
  }

  // fillStyle 由调用方设好。分割点统一 round 到整数物理像素，相邻块元素的
  // 拼接处既不留缝也不重叠。
  private drawBlockElement(
    codepoint: number,
    x: number,
    y: number,
    width: number,
    height: number
  ): void {
    const context = this.mainContext;
    const sx = (n: number) => Math.round((width * n) / 8);
    const sy = (n: number) => Math.round((height * n) / 8);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      context.fillRect(x + x0, y + y0, x1 - x0, y1 - y0);
    };

    if (codepoint === 0x2580) {
      // ▀ 上半块
      fill(0, 0, width, sy(4));
      return;
    }
    if (codepoint >= 0x2581 && codepoint <= 0x2588) {
      // ▁..█ 自下而上 n/8
      fill(0, sy(8 - (codepoint - 0x2580)), width, height);
      return;
    }
    if (codepoint >= 0x2589 && codepoint <= 0x258f) {
      // ▉..▏ 自左起 n/8
      fill(0, 0, sx(0x2590 - codepoint), height);
      return;
    }
    if (codepoint === 0x2590) {
      // ▐ 右半块
      fill(sx(4), 0, width, height);
      return;
    }
    const shadeAlpha = SHADE_ALPHA.get(codepoint);
    if (shadeAlpha !== undefined) {
      // ░▒▓ 按前景色 alpha 混合
      const previousAlpha = context.globalAlpha;
      context.globalAlpha = previousAlpha * shadeAlpha;
      fill(0, 0, width, height);
      context.globalAlpha = previousAlpha;
      return;
    }
    if (codepoint === 0x2594) {
      // ▔ 上 1/8
      fill(0, 0, width, sy(1));
      return;
    }
    if (codepoint === 0x2595) {
      // ▕ 右 1/8
      fill(sx(7), 0, width, height);
      return;
    }
    const quadrants = QUADRANT_FLAGS.get(codepoint) ?? 0;
    const midX = sx(4);
    const midY = sy(4);
    if (quadrants & 0b0001) fill(0, 0, midX, midY);
    if (quadrants & 0b0010) fill(midX, 0, width, midY);
    if (quadrants & 0b0100) fill(0, midY, midX, height);
    if (quadrants & 0b1000) fill(midX, midY, width, height);
  }

  // 光标层的每帧入口：解析光标色后交给 CursorLayer（落定语义见该模块注释）。
  // 光标色取自 ghostty render state（colors.cursor 缺省时回落到 colors.foreground），
  // 不读 this.theme——主题切换由 WASM 侧 setTerminalTheme 反映到 render state。
  private updateCursor(frame: CanvasRendererFrame, wiped: boolean): void {
    const cssColor = this.toCss(frame.meta.colors.cursor ?? frame.meta.colors.foreground);
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

  private resolveFont(style: GhosttyRenderCellStyle): string {
    const index = fontVariantIndex(style);
    const cached = this.fontVariants[index];
    if (cached !== null) {
      return cached;
    }

    const font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${this.deviceFontSize}px ${this.fontFamily}`;
    this.fontVariants[index] = font;
    return font;
  }

  private toCss(color: GhosttyColorRgb): string {
    const key = colorKey(color);
    const cached = this.colorCache.get(key);
    if (cached) {
      return cached;
    }

    const css = colorToCss(color);
    this.colorCache.set(key, css);
    return css;
  }
}

export type {
  CanvasRendererDebugState,
  CanvasRendererFrame,
  CanvasRendererOptions,
  LinkUnderlineSegment,
};
