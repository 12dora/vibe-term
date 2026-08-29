import { blockElementCodepoint, drawBlockElement } from './block-elements';
import { drawCellDecorations } from './cell-decorations';
import {
  type CursorCell,
  cursorShapeGeometry,
  drawCursorShape,
  invalidatedCursorRow,
} from './cursor-painter';
import type {
  GhosttyCellDimensions,
  GhosttyColorRgb,
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

function colorToCss(color: GhosttyColorRgb): string {
  return `rgb(${color.r} ${color.g} ${color.b})`;
}

function isSpacerCell(cell: GhosttyRenderCell): boolean {
  return cell.widthKind === 'spacer-tail' || cell.widthKind === 'spacer-head';
}

function shouldPaintForeground(cell: GhosttyRenderCell): boolean {
  return !isSpacerCell(cell) && cell.text.length > 0 && !cell.style.invisible;
}

function cellSpanWidth(cell: GhosttyRenderCell, deviceCellWidth: number): number {
  return cell.widthKind === 'wide' ? deviceCellWidth * 2 : deviceCellWidth;
}

function resolveCellBackground(
  cell: GhosttyRenderCell,
  colors: GhosttyRenderSnapshotMeta['colors']
): GhosttyColorRgb {
  return cell.style.inverse
    ? (cell.fgColor ?? colors.foreground)
    : (cell.bgColor ?? colors.background);
}

function resolveCellForeground(
  cell: GhosttyRenderCell,
  colors: GhosttyRenderSnapshotMeta['colors']
): GhosttyColorRgb {
  return cell.style.inverse
    ? (cell.bgColor ?? colors.background)
    : (cell.fgColor ?? colors.foreground);
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
  private lastCursor: CursorCell | null = null;
  private frameCount = 0;
  private lastDrawnRows: number[] = [];
  private readonly colorCache = new Map<string, string>();
  private readonly fontCache = new Map<string, string>();
  private cursorBlinkVisible = true;
  private cursorBlinkTimer: ReturnType<typeof setInterval> | null = null;

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
  }

  setTheme(theme: GhosttyTheme): void {
    this.theme = theme;
    this.colorCache.clear();
  }

  render(frame: CanvasRendererFrame): void {
    this.frameCount += 1;
    this.lastDrawnRows = [];
    this.cellDimensions = frame.cellDimensions;
    const wiped = this.resize(frame.meta.cols, frame.meta.rows);
    this.drawSelection(
      frame.selectionRects ?? [],
      frame.selectionColor ?? this.theme.selectionBackground
    );

    // canvas 位图被 resize 清空 / 外部强制全画 → 必须忽略 dirty='clean' 早退，
    // 否则屏幕空白（issue #45 bug 3）。
    const effectiveDirty = wiped || frame.forceFull === true ? 'full' : frame.meta.dirty;

    if (effectiveDirty === 'clean') {
      this.drawCursor(frame.meta);
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

    this.drawCursor(frame.meta);
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
    this.fontCache.clear();
    this.lastCursor = null;
    this.stopCursorBlink();
  }

  private startCursorBlink(): void {
    if (this.cursorBlinkTimer) {
      return;
    }
    this.cursorBlinkTimer = setInterval(() => {
      this.cursorBlinkVisible = !this.cursorBlinkVisible;
      this.cursorCanvas.style.opacity = this.cursorBlinkVisible ? '1' : '0';
    }, 1000);
  }

  private stopCursorBlink(): void {
    if (this.cursorBlinkTimer) {
      clearInterval(this.cursorBlinkTimer);
      this.cursorBlinkTimer = null;
    }
    this.cursorBlinkVisible = true;
    this.cursorCanvas.style.opacity = '1';
  }

  // 返回 true 表示触发了 canvas.width/height 赋值（HTML5 标准会 wipe 已绘位图），
  // 调用方需把 dirty 视作 'full' 强制全画以避免空白屏（issue #45 bug 3）。
  private resize(cols: number, rows: number): boolean {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const deviceCellWidth = Math.max(1, Math.round(this.cellDimensions.width * dpr));
    const deviceCellHeight = Math.max(1, Math.round(this.cellDimensions.height * dpr));

    if (
      this.cols === nextCols &&
      this.rows === nextRows &&
      this.dpr === dpr &&
      this.deviceCellWidth === deviceCellWidth &&
      this.deviceCellHeight === deviceCellHeight
    ) {
      return false;
    }

    this.cols = nextCols;
    this.rows = nextRows;
    this.dpr = dpr;
    this.deviceCellWidth = deviceCellWidth;
    this.deviceCellHeight = deviceCellHeight;
    this.deviceFontSize = this.fontSize * dpr;
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

  private drawSelection(rects: GhosttySelectionRect[], color: string): void {
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

      const bg = resolveCellBackground(cell, colors);
      if (
        bg.r !== colors.background.r ||
        bg.g !== colors.background.g ||
        bg.b !== colors.background.b
      ) {
        this.mainContext.fillStyle = this.toCss(bg);
        this.mainContext.fillRect(
          cell.x * this.deviceCellWidth,
          y,
          cellSpanWidth(cell, this.deviceCellWidth),
          this.deviceCellHeight
        );
      }
    }
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
      if (!shouldPaintForeground(cell)) {
        continue;
      }

      const x = cell.x * this.deviceCellWidth;
      const cellWidth = cellSpanWidth(cell, this.deviceCellWidth);

      this.mainContext.fillStyle = this.toCss(resolveCellForeground(cell, colors));
      const blockCodepoint = blockElementCodepoint(cell.codepoints);
      if (blockCodepoint !== null) {
        drawBlockElement(this.mainContext, blockCodepoint, {
          x,
          y,
          width: cellWidth,
          height: this.deviceCellHeight,
        });
      } else {
        this.mainContext.font = this.resolveFont(cell.style);
        this.mainContext.fillText(cell.text, x, y + this.textBaselineY);
      }

      drawCellDecorations(this.mainContext, cell.style, {
        x,
        y,
        cellWidth,
        cellHeight: this.deviceCellHeight,
        lineThickness,
        textTopGap: this.textTopGap,
        glyphBoxHeight: this.glyphBoxHeight,
      });
    }
  }

  private drawCursor(meta: GhosttyRenderSnapshotMeta): void {
    const colors = meta.colors;
    const cursor = meta.cursor;
    const previous = this.lastCursor;
    this.cursorContext.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);

    if (!cursor.visible || cursor.x === null || cursor.y === null) {
      this.lastCursor = null;
      this.stopCursorBlink();
      return;
    }

    // 光标色仍取自 ghostty render state（colors.cursor 缺省时回落到 colors.foreground），
    // 不读 this.theme——主题切换由 WASM 侧 setTerminalTheme 反映到 render state。
    drawCursorShape(
      this.cursorContext,
      cursor.style,
      cursorShapeGeometry({
        column: cursor.x,
        row: cursor.y,
        wideTail: cursor.wideTail,
        deviceCellWidth: this.deviceCellWidth,
        deviceCellHeight: this.deviceCellHeight,
        dpr: this.dpr,
      }),
      this.toCss(colors.cursor ?? colors.foreground)
    );

    if (cursor.blinking) {
      this.startCursorBlink();
    } else {
      this.stopCursorBlink();
    }

    this.lastCursor = {
      x: cursor.x,
      y: cursor.y,
      style: cursor.style,
      blinking: cursor.blinking,
    };

    const invalidatedRow = invalidatedCursorRow(previous, this.lastCursor);
    if (invalidatedRow !== null) {
      this.lastDrawnRows.push(invalidatedRow);
    }
  }

  private resolveFont(style: GhosttyRenderRow['cells'][number]['style']): string {
    const deviceFontSize = this.deviceFontSize;
    const key = [
      style.italic ? 'italic' : 'normal',
      style.bold ? '700' : '400',
      `${deviceFontSize}px`,
      this.fontFamily,
    ].join('|');

    const cached = this.fontCache.get(key);
    if (cached) {
      return cached;
    }

    const font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${deviceFontSize}px ${this.fontFamily}`;
    this.fontCache.set(key, font);
    return font;
  }

  private toCss(color: GhosttyColorRgb): string {
    const key = `${color.r},${color.g},${color.b}`;
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
