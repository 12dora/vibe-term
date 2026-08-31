import type { GhosttyRenderSnapshotMeta } from './types';

export type CursorSnapshot = GhosttyRenderSnapshotMeta['cursor'];

type CursorCell = {
  x: number;
  y: number;
  style: CursorSnapshot['style'];
  blinking: boolean;
};

type DeviceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type PendingCursor = {
  cursor: CursorSnapshot;
  cssColor: string;
};

const BLINK_INTERVAL_MS = 1000;

// 光标层：独立 canvas，只擦上一次画过的那一格（位图被 resize 清空时才整层擦），
// 位置/形状/闪烁/颜色都未变时整帧跳过。闪烁不重画，只切整层 opacity。
//
// 落定（settled）语义：一次应用整屏重绘的字节常分多个 write 到达（websocket / tmux
// %output 分片），渲染帧因此可能落在重绘中途，此刻的光标位置只是笔尖所在（刚写完的
// 字符后面那一格），不是应用这一帧的最终落点。未落定的帧只把状态挂起（update 返回
// 时屏幕保持原样），由渲染协调器在输出静默的下一帧调 commit() 落笔。
export class CursorLayer {
  private last: CursorCell | null = null;
  private lastRect: DeviceRect | null = null;
  private lastColor = '';
  private pending: PendingCursor | null = null;
  private blinkVisible = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private cellWidth = 9;
  private cellHeight = 17;
  private dpr = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D
  ) {}

  setMetrics(cellWidth: number, cellHeight: number, dpr: number): void {
    this.cellWidth = cellWidth;
    this.cellHeight = cellHeight;
    this.dpr = dpr;
  }

  // 返回光标离开的旧行（供调用方计入 lastDrawnRows），没有换行则返回 null。
  // settled=false 且屏幕上已有一支画好的光标时只挂起，不动像素；首帧 / 光标刚从隐藏
  // 转可见 / 位图被清空（wiped）必须立刻落笔，否则光标会缺一帧。
  update(
    cursor: CursorSnapshot,
    cssColor: string,
    wiped: boolean,
    settled: boolean
  ): number | null {
    if (!settled && !wiped && this.last !== null) {
      this.pending = { cursor, cssColor };
      return null;
    }

    this.pending = null;
    return this.draw(cursor, cssColor, wiped);
  }

  commit(): number | null {
    const pending = this.pending;
    if (!pending) {
      return null;
    }

    this.pending = null;
    return this.draw(pending.cursor, pending.cssColor, false);
  }

  dispose(): void {
    this.last = null;
    this.lastRect = null;
    this.pending = null;
    this.stopBlink();
  }

  private draw(cursor: CursorSnapshot, cssColor: string, wiped: boolean): number | null {
    if (!cursor.visible || cursor.x === null || cursor.y === null) {
      this.hide(wiped);
      return null;
    }

    const width = cursor.wideTail ? this.cellWidth * 2 : this.cellWidth;
    if (!wiped && this.alreadyDrawn(cursor, cssColor, width)) {
      return null;
    }

    this.clear(wiped);
    this.paintShape(
      cursor.style,
      cursor.x * this.cellWidth,
      cursor.y * this.cellHeight,
      width,
      cssColor
    );

    if (cursor.blinking) {
      this.startBlink();
    } else {
      this.stopBlink();
    }

    return this.commitState(cursor.x, cursor.y, cursor.style, cursor.blinking, width, cssColor);
  }

  private hide(wiped: boolean): void {
    if (this.last || wiped) {
      this.clear(wiped);
    }
    this.last = null;
    this.lastRect = null;
    this.stopBlink();
  }

  private clear(wiped: boolean): void {
    if (wiped || !this.lastRect) {
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }

    const rect = this.lastRect;
    this.context.clearRect(rect.x, rect.y, rect.width, rect.height);
  }

  // 位置 / 形状 / 闪烁 / 颜色 / 宽度全部与上次落笔一致时整帧跳过。
  private alreadyDrawn(cursor: CursorSnapshot, cssColor: string, width: number): boolean {
    const previous = this.last;
    return (
      previous !== null &&
      previous.x === cursor.x &&
      previous.y === cursor.y &&
      previous.style === cursor.style &&
      previous.blinking === cursor.blinking &&
      this.lastColor === cssColor &&
      this.lastRect !== null &&
      this.lastRect.width === width
    );
  }

  private paintShape(
    style: CursorSnapshot['style'],
    x: number,
    y: number,
    width: number,
    cssColor: string
  ): void {
    const height = this.cellHeight;
    const thickness = Math.max(1, Math.round(this.dpr));
    const lineThickness = 2 * thickness;
    const context = this.context;

    context.fillStyle = cssColor;
    context.strokeStyle = cssColor;
    context.globalAlpha = 0.7;
    if (style === 'bar') {
      context.fillRect(x, y, lineThickness, height);
    } else if (style === 'underline') {
      context.fillRect(
        x,
        y + height - lineThickness,
        Math.max(width - thickness, thickness),
        lineThickness
      );
    } else if (style === 'block-hollow') {
      // 描边沿 cell 内缘走：奇数线宽偏移半物理像素，避免 1px 边框被抗锯齿糊成 2px。
      context.lineWidth = thickness;
      context.strokeRect(
        x + thickness / 2,
        y + thickness / 2,
        Math.max(width - thickness, thickness),
        Math.max(height - thickness, thickness)
      );
    } else {
      context.fillRect(x, y, width, height);
    }
    context.globalAlpha = 1;
  }

  private commitState(
    cursorX: number,
    cursorY: number,
    style: CursorCell['style'],
    blinking: boolean,
    width: number,
    cssColor: string
  ): number | null {
    const previous = this.last;

    this.last = { x: cursorX, y: cursorY, style, blinking };
    this.lastRect = {
      x: cursorX * this.cellWidth,
      y: cursorY * this.cellHeight,
      width,
      height: this.cellHeight,
    };
    this.lastColor = cssColor;

    const moved =
      previous !== null &&
      (previous.x !== cursorX ||
        previous.y !== cursorY ||
        previous.style !== style ||
        previous.blinking !== blinking);
    return moved && previous ? previous.y : null;
  }

  private startBlink(): void {
    if (this.blinkTimer) {
      return;
    }
    this.blinkTimer = setInterval(() => {
      this.blinkVisible = !this.blinkVisible;
      this.canvas.style.opacity = this.blinkVisible ? '1' : '0';
    }, BLINK_INTERVAL_MS);
  }

  private stopBlink(): void {
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.blinkVisible = true;
    this.canvas.style.opacity = '1';
  }
}
