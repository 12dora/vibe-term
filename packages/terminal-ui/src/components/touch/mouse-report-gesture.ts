import type { TouchPoint } from './touch-geometry';
import type { TerminalScroller } from './types';

// 触摸 → 鼠标上报（press/motion/release）。独占最后一次 motion 坐标，
// 供 touchcancel / 主指抬起时补发 release 用（丢 release 会让 TUI 卡在"左键按住"）。
export class MouseReportGesture {
  private lastDragX = 0;
  private lastDragY = 0;

  press(terminal: TerminalScroller | null, clientX: number, clientY: number): boolean {
    return Boolean(terminal?.sendTouchMouseEvent?.({ action: 'press', clientX, clientY }));
  }

  motion(terminal: TerminalScroller | null, clientX: number, clientY: number): void {
    this.lastDragX = clientX;
    this.lastDragY = clientY;
    terminal?.sendTouchMouseEvent?.({ action: 'motion', clientX, clientY });
  }

  release(terminal: TerminalScroller | null, clientX: number, clientY: number): void {
    terminal?.sendTouchMouseEvent?.({ action: 'release', clientX, clientY });
  }

  // tap：press/release 都用起点坐标（阈值内的抖动不应改变点击 cell）
  tap(terminal: TerminalScroller | null, clientX: number, clientY: number): void {
    if (this.press(terminal, clientX, clientY)) {
      this.release(terminal, clientX, clientY);
    }
  }

  releaseAt(terminal: TerminalScroller | null, endedTouch: TouchPoint | null): void {
    this.release(
      terminal,
      endedTouch?.clientX ?? this.lastDragX,
      endedTouch?.clientY ?? this.lastDragY
    );
  }
}
