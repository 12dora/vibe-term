import type { TerminalScroller } from './types';

// 触摸 → 鼠标上报。触摸端只保留 tap（press+release）：单指移动一律是滚动，
// 不再向 TUI 流式上报 motion，因此也不存在需要补发 release 的"卡住左键"场景。
export class MouseReportGesture {
  private send(
    terminal: TerminalScroller | null,
    action: 'press' | 'release',
    clientX: number,
    clientY: number
  ): boolean {
    return Boolean(terminal?.sendTouchMouseEvent?.({ action, clientX, clientY }));
  }

  // tap：press/release 都用起点坐标（阈值内的抖动不应改变点击 cell）；
  // press 发送失败（上报模式中途关闭）则不补 release
  tap(terminal: TerminalScroller | null, clientX: number, clientY: number): void {
    if (this.send(terminal, 'press', clientX, clientY)) {
      this.send(terminal, 'release', clientX, clientY);
    }
  }
}
