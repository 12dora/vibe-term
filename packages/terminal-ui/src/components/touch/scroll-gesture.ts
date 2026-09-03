import { findScrollTargets } from './scroll-bypass';
import {
  type TouchPointList,
  accumulateScrollPixels,
  pendingPixelsToLines,
  terminalLineHeight,
  touchCentroidY,
} from './touch-geometry';
import type { ResolveTerminal, TerminalScroller } from './types';

export interface ScrollOutcome {
  didScroll: boolean;
  atTopWhilePullingDown: boolean;
}

// 单指滚动 + 双指滚轮。独占 pendingPixelDelta（亚行像素累积）、lastTouchY、wheelCentroidY。
export class TouchScrollGesture {
  private pendingPixelDelta = 0;
  private lastTouchY = 0;
  private wheelCentroidY = 0;

  constructor(private readonly container: Element) {}

  anchorSingle(clientY: number): void {
    this.lastTouchY = clientY;
    this.pendingPixelDelta = 0;
  }

  anchorWheel(touches: TouchPointList): void {
    this.wheelCentroidY = touchCentroidY(touches);
  }

  beginWheel(touches: TouchPointList): void {
    this.pendingPixelDelta = 0;
    this.anchorWheel(touches);
  }

  resetAccumulator(): void {
    this.pendingPixelDelta = 0;
  }

  // 累积像素 → 整行喂给 handleViewportGesture（上报模式下由终端编码为滚轮 64/65，
  // 非上报模式走本地滚动/altScroll——touch 分支的 gestureToLines 无亚行累积，必须传整行像素）
  private feedViewportGesture(
    terminal: TerminalScroller,
    deltaY: number,
    clientX: number,
    clientY: number
  ): boolean {
    const lineHeight = terminalLineHeight(terminal);
    this.pendingPixelDelta = accumulateScrollPixels(this.pendingPixelDelta, deltaY);
    const linesToScroll = pendingPixelsToLines(this.pendingPixelDelta, lineHeight);
    if (linesToScroll === 0 || typeof terminal.handleViewportGesture !== 'function') {
      return false;
    }
    const didScroll = terminal.handleViewportGesture({
      source: 'touch',
      deltaY: linesToScroll * lineHeight,
      clientX,
      clientY,
    });
    this.pendingPixelDelta -= linesToScroll * lineHeight;
    return didScroll;
  }

  handleWheelMove(
    terminal: TerminalScroller | null,
    touches: TouchPointList,
    fallbackClientX: number
  ): void {
    const centroidY = touchCentroidY(touches);
    const deltaY = this.wheelCentroidY - centroidY;
    this.wheelCentroidY = centroidY;
    if (terminal && deltaY !== 0) {
      const anchor = touches.item(0);
      this.feedViewportGesture(terminal, deltaY, anchor?.clientX ?? fallbackClientX, centroidY);
    }
  }

  // 取本次 move 的纵向位移并重锚。平移路径也必须走它，否则锚点不更新，
  // 手势从平移回落到 scrollback 时会一次性丢出整段累积位移。
  takeVerticalDelta(clientY: number): number {
    const deltaY = this.lastTouchY - clientY;
    this.lastTouchY = clientY;
    return deltaY;
  }

  // 返回 null = 本次 move 未产生滚动语义（零位移 / 无可滚元素），调用方不得 preventDefault
  applyVerticalDelta(
    resolveTerminal: ResolveTerminal,
    deltaY: number,
    clientX: number,
    clientY: number
  ): ScrollOutcome | null {
    if (deltaY === 0) return null;

    const terminal = resolveTerminal();
    if (!terminal) {
      return this.scrollDomFallback(deltaY);
    }
    if (typeof terminal.handleViewportGesture === 'function') {
      return {
        didScroll: this.feedViewportGesture(terminal, deltaY, clientX, clientY),
        atTopWhilePullingDown: false,
      };
    }
    return this.scrollLinesDirect(terminal, deltaY);
  }

  private scrollLinesDirect(terminal: TerminalScroller, deltaY: number): ScrollOutcome {
    const lineHeight = terminalLineHeight(terminal);
    this.pendingPixelDelta = accumulateScrollPixels(this.pendingPixelDelta, deltaY);
    const linesToScroll = pendingPixelsToLines(this.pendingPixelDelta, lineHeight);
    if (linesToScroll === 0) {
      return { didScroll: false, atTopWhilePullingDown: false };
    }
    // buffer.active.viewportY 只在渲染落地时更新，而滚动渲染已改为 rAF 合并：
    // 「本次是否真的滚动了」必须由 scrollLines 的返回值给出。旧终端（返回 void）
    // 才回落到前后差比对。
    const beforeViewportY = terminal.buffer?.active?.viewportY ?? 0;
    const reported = terminal.scrollLines(linesToScroll);
    const afterViewportY = terminal.buffer?.active?.viewportY ?? 0;
    this.pendingPixelDelta -= linesToScroll * lineHeight;
    if (typeof reported === 'boolean') {
      return {
        didScroll: reported,
        atTopWhilePullingDown: linesToScroll < 0 && !reported,
      };
    }
    return {
      didScroll: beforeViewportY !== afterViewportY,
      atTopWhilePullingDown: linesToScroll < 0 && beforeViewportY <= 0 && afterViewportY <= 0,
    };
  }

  private scrollDomFallback(deltaY: number): ScrollOutcome | null {
    const scrollTargets = findScrollTargets(this.container);
    if (scrollTargets.length === 0) return null;

    let didScroll = false;
    let atTopWhilePullingDown = false;
    for (const target of scrollTargets) {
      const previousScrollTop = target.scrollTop;
      target.scrollTop += deltaY;
      const nextScrollTop = target.scrollTop;

      if (Math.abs(nextScrollTop - previousScrollTop) > 0) {
        didScroll = true;
      }
      if (deltaY < 0 && nextScrollTop <= 0) {
        atTopWhilePullingDown = true;
      }
    }

    if (!didScroll) {
      const xtermRoot = this.container.querySelector('.xterm');
      if (xtermRoot instanceof HTMLElement) {
        const wheelEvent = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          deltaY,
        });
        const dispatched = xtermRoot.dispatchEvent(wheelEvent);
        didScroll = wheelEvent.defaultPrevented || !dispatched;
      }
    }

    return { didScroll, atTopWhilePullingDown };
  }
}
