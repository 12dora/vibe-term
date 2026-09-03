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

/** 惯性帧驱动；requestFrame 返回 null（无 rAF 的宿主）即视为不支持惯性。 */
export interface FlingFrames {
  requestFrame: (callback: () => void) => unknown | null;
  cancelFrame: (handle: unknown) => void;
}

export interface TouchScrollGestureOptions {
  frames?: FlingFrames;
  now?: () => number;
  prefersReducedMotion?: () => boolean;
}

export const FLING_FRAME_MS = 1000 / 60;
/** 速度取样窗口：抬指前 100 ms 的位移，短于此的抖动不参与 */
export const FLING_VELOCITY_WINDOW_MS = 100;
export const FLING_DECAY_PER_FRAME = 0.95;
/** 起始阈值：低于此速度视为「慢慢挪」，不产生惯性 */
export const FLING_MIN_START_VELOCITY_PX = 4;
/** 停止阈值：衰减到此速度以下即结束 */
export const FLING_MIN_VELOCITY_PX = 0.8;
/** 上限：抬指瞬间的抖动可能算出离谱速度，钳住避免一次甩到底 */
export const FLING_MAX_VELOCITY_PX = 120;

interface VelocitySample {
  time: number;
  y: number;
}

interface FlingContext {
  resolveTerminal: ResolveTerminal;
  clientX: number;
  clientY: number;
}

const domFlingFrames: FlingFrames = {
  requestFrame: (callback) =>
    typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : null,
  cancelFrame: (handle) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
  },
};

function domPrefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 取样窗口内的平均速度，换算成「每帧位移」并按 deltaY 的符号约定（手指上滑为正）输出。
export function flingVelocityPerFrame(
  samples: readonly VelocitySample[],
  endTime: number,
  windowMs: number = FLING_VELOCITY_WINDOW_MS,
  frameMs: number = FLING_FRAME_MS
): number {
  const cutoff = endTime - windowMs;
  let firstIndex = -1;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if ((samples[i] as VelocitySample).time < cutoff) break;
    firstIndex = i;
  }
  if (firstIndex < 0 || firstIndex >= samples.length - 1) return 0;

  const first = samples[firstIndex] as VelocitySample;
  const last = samples[samples.length - 1] as VelocitySample;
  const elapsed = last.time - first.time;
  if (elapsed <= 0) return 0;

  const velocity = ((first.y - last.y) / elapsed) * frameMs;
  if (velocity > FLING_MAX_VELOCITY_PX) return FLING_MAX_VELOCITY_PX;
  if (velocity < -FLING_MAX_VELOCITY_PX) return -FLING_MAX_VELOCITY_PX;
  return velocity;
}

// 单指滚动 + 双指滚轮 + 抬指惯性。独占 pendingPixelDelta（亚行像素累积）、lastTouchY、wheelCentroidY。
export class TouchScrollGesture {
  private pendingPixelDelta = 0;
  private lastTouchY = 0;
  private wheelCentroidY = 0;

  private readonly frames: FlingFrames;
  private readonly now: () => number;
  private readonly prefersReducedMotion: () => boolean;

  private samples: VelocitySample[] = [];
  private lastScrollContext: FlingContext | null = null;
  private scrolledDuringGesture = false;
  private flingHandle: unknown = null;
  private flingContext: FlingContext | null = null;
  private flingVelocity = 0;

  constructor(
    private readonly container: Element,
    options: TouchScrollGestureOptions = {}
  ) {
    this.frames = options.frames ?? domFlingFrames;
    this.now = options.now ?? (() => Date.now());
    this.prefersReducedMotion = options.prefersReducedMotion ?? domPrefersReducedMotion;
  }

  anchorSingle(clientY: number): void {
    // 新手势落指立刻掐掉惯性：与原生滚动一致，触摸即停
    this.cancelFling();
    this.lastTouchY = clientY;
    this.pendingPixelDelta = 0;
    this.samples = [{ time: this.now(), y: clientY }];
    this.lastScrollContext = null;
    this.scrolledDuringGesture = false;
  }

  anchorWheel(touches: TouchPointList): void {
    this.wheelCentroidY = touchCentroidY(touches);
  }

  beginWheel(touches: TouchPointList): void {
    this.cancelFling();
    this.pendingPixelDelta = 0;
    this.anchorWheel(touches);
  }

  resetAccumulator(): void {
    this.pendingPixelDelta = 0;
  }

  /** 抬指：按取样窗口内的速度起一段惯性。无速度 / 未真正滚过 / reduced-motion 时为 no-op。 */
  endGesture(): void {
    const context = this.lastScrollContext;
    const samples = this.samples;
    this.samples = [];
    this.lastScrollContext = null;
    if (!context || !this.scrolledDuringGesture) return;
    this.scrolledDuringGesture = false;
    if (this.prefersReducedMotion()) return;

    const velocity = flingVelocityPerFrame(samples, this.now());
    if (Math.abs(velocity) < FLING_MIN_START_VELOCITY_PX) return;

    this.flingContext = context;
    this.flingVelocity = velocity;
    this.scheduleFlingFrame();
  }

  cancelFling(): void {
    if (this.flingHandle !== null) this.frames.cancelFrame(this.flingHandle);
    this.flingHandle = null;
    this.flingContext = null;
    this.flingVelocity = 0;
  }

  private scheduleFlingFrame(): void {
    const handle = this.frames.requestFrame(() => {
      this.flingHandle = null;
      this.stepFling();
    });
    if (handle === null) {
      // 无 rAF 的宿主：不做惯性，而不是同步一次性甩完
      this.flingContext = null;
      this.flingVelocity = 0;
      return;
    }
    this.flingHandle = handle;
  }

  private stepFling(): void {
    const context = this.flingContext;
    if (!context) return;
    if (!context.resolveTerminal()) {
      this.cancelFling();
      return;
    }

    const outcome = this.applyVerticalDelta(
      context.resolveTerminal,
      this.flingVelocity,
      context.clientX,
      context.clientY
    );
    if (!outcome || outcome.atTopWhilePullingDown) {
      this.cancelFling();
      return;
    }

    this.flingVelocity *= FLING_DECAY_PER_FRAME;
    if (Math.abs(this.flingVelocity) < FLING_MIN_VELOCITY_PX) {
      this.cancelFling();
      return;
    }
    this.scheduleFlingFrame();
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
    this.noteVelocitySample(clientY);
    return deltaY;
  }

  private noteVelocitySample(clientY: number): void {
    const time = this.now();
    this.samples.push({ time, y: clientY });
    const cutoff = time - FLING_VELOCITY_WINDOW_MS;
    // 窗口外的取样只保留一个（作为窗口左端点），其余丢弃
    let drop = 0;
    while (
      drop + 1 < this.samples.length &&
      (this.samples[drop + 1] as VelocitySample).time < cutoff
    ) {
      drop += 1;
    }
    if (drop > 0) this.samples = this.samples.slice(drop);
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
    this.lastScrollContext = { resolveTerminal, clientX, clientY };
    const outcome =
      typeof terminal.handleViewportGesture === 'function'
        ? {
            didScroll: this.feedViewportGesture(terminal, deltaY, clientX, clientY),
            atTopWhilePullingDown: false,
          }
        : this.scrollLinesDirect(terminal, deltaY);
    if (outcome.didScroll) this.scrolledDuringGesture = true;
    return outcome;
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
