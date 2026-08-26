import { LONG_PRESS_SELECT_MS } from './touch-geometry';
import type { TerminalScroller } from './types';

// 长按 word 选择。独占长按定时器，保证 arm/clear 成对，卸载时可一次性拆除。
export class LongPressSelectionGesture {
  private timer: ReturnType<typeof setTimeout> | null = null;

  isArmed(): boolean {
    return this.timer !== null;
  }

  arm(onElapsed: () => void, delayMs: number = LONG_PRESS_SELECT_MS): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      onElapsed();
    }, delayMs);
  }

  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  start(terminal: TerminalScroller | null, clientX: number, clientY: number): boolean {
    return Boolean(terminal?.startTouchSelection?.(clientX, clientY, 'word'));
  }

  update(terminal: TerminalScroller | null, clientX: number, clientY: number): void {
    terminal?.updateTouchSelection?.(clientX, clientY);
  }

  end(terminal: TerminalScroller | null): void {
    terminal?.endTouchSelection?.();
  }
}
