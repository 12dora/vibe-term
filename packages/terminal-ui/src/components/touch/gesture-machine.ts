import { MouseReportGesture } from './mouse-report-gesture';
import { TouchPanAnchor, planPan } from './pan-gesture';
import {
  type ElementFromPoint,
  documentElementFromPoint,
  hitsScrollbarElement,
  shouldBypassCustomScroll,
} from './scroll-bypass';
import { TouchScrollGesture } from './scroll-gesture';
import { LongPressSelectionGesture } from './selection-gesture';
import { type TouchPoint, exceedsMoveTolerance, findTouchById } from './touch-geometry';
import type { ResolveTerminal, TouchGestureState } from './types';

interface PanOutcome {
  panned: boolean;
  remainingY: number;
}

export interface GestureMachineOptions {
  container: Element;
  resolveTerminal: ResolveTerminal;
  elementFromPoint?: ElementFromPoint;
}

function preventIfCancelable(event: Event): void {
  if (event.cancelable) {
    event.preventDefault();
  }
}

export class MobileTouchGestureMachine {
  private state: TouchGestureState = 'idle';
  private touchId: number | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private reporting = false;

  private readonly container: Element;
  private readonly resolveTerminal: ResolveTerminal;
  private readonly elementFromPoint: ElementFromPoint;
  private readonly scroll: TouchScrollGesture;
  private readonly pan = new TouchPanAnchor();
  private readonly selection = new LongPressSelectionGesture();
  private readonly mouseReport = new MouseReportGesture();

  constructor(options: GestureMachineOptions) {
    this.container = options.container;
    this.resolveTerminal = options.resolveTerminal;
    this.elementFromPoint = options.elementFromPoint ?? documentElementFromPoint;
    this.scroll = new TouchScrollGesture(options.container);
  }

  currentState(): TouchGestureState {
    return this.state;
  }

  dispose(): void {
    this.selection.clear();
  }

  private resetGesture(): void {
    this.selection.clear();
    this.state = 'idle';
    this.touchId = null;
    this.reporting = false;
    this.scroll.resetAccumulator();
    this.pan.reset();
  }

  // 平移分支：仅 follower（终端暴露 panMetrics）且非上报模式生效，且只在轴锁命中的
  // 那一轴超尺寸时才吃位移；纵向到边的余量原样交回 scrollback（嵌套滚动语义）。
  private applyPan(touch: TouchPoint, deltaY: number): PanOutcome {
    const deltaX = this.pan.takeHorizontalDelta(touch.clientX);
    if (this.reporting) {
      return { panned: false, remainingY: deltaY };
    }

    const terminal = this.resolveTerminal();
    const metrics = terminal?.panMetrics?.() ?? null;
    if (!terminal || !metrics || typeof terminal.panBy !== 'function') {
      return { panned: false, remainingY: deltaY };
    }

    const axis = this.pan.resolveAxis(touch.clientX, touch.clientY);
    const plan = planPan(axis, metrics, deltaX, deltaY);
    if (plan.panX === 0 && plan.panY === 0) {
      return { panned: false, remainingY: plan.remainingY };
    }

    const applied = terminal.panBy(plan.panX, plan.panY);
    return {
      panned: applied.deltaX !== 0 || applied.deltaY !== 0,
      remainingY: plan.remainingY,
    };
  }

  private primaryTouch(touches: TouchList): TouchPoint | null {
    return findTouchById(touches, this.touchId) ?? touches.item(0);
  }

  // 上报模式（alt-screen TUI）下本地滚动条无意义，右缘 36px 热区会变成 TUI 死区：
  // 仅在直接命中滚动条元素时才 bypass
  private bypasses(clientX: number, clientY: number, eventTarget: EventTarget | null): boolean {
    if (this.reporting) {
      return hitsScrollbarElement(clientX, clientY, eventTarget, this.elementFromPoint);
    }
    return shouldBypassCustomScroll(
      this.container,
      clientX,
      clientY,
      eventTarget,
      this.elementFromPoint
    );
  }

  readonly handleTouchStart = (event: TouchEvent): void => {
    if (event.touches.length === 1) {
      this.selection.clear();
      const touch = event.touches.item(0);
      if (!touch) return;

      this.touchId = touch.identifier;
      this.touchStartX = touch.clientX;
      this.touchStartY = touch.clientY;
      this.scroll.anchorSingle(touch.clientY);
      this.pan.anchor(touch.clientX, touch.clientY);

      const terminal = this.resolveTerminal();
      this.reporting = Boolean(terminal?.isMouseReporting?.());

      if (this.bypasses(touch.clientX, touch.clientY, event.target)) {
        this.state = 'bypass';
        return;
      }

      this.state = this.reporting ? 'pending' : 'scroll';
      this.selection.arm(() => {
        const activeTerminal = this.resolveTerminal();
        if (this.selection.start(activeTerminal, this.touchStartX, this.touchStartY)) {
          this.state = 'select';
        }
      });
      return;
    }

    // 第二指加入：tap 待定（pending）→ 双指滚轮；
    // wheel 中触点数变化 → 只重锚质心，不产生 delta
    if (this.state === 'pending') {
      this.selection.clear();
      this.state = 'wheel';
      this.scroll.beginWheel(event.touches);
      return;
    }
    if (this.state === 'wheel') {
      this.scroll.anchorWheel(event.touches);
    }
  };

  readonly handleTouchMove = (event: TouchEvent): void => {
    if (this.state === 'idle' || this.state === 'bypass') return;

    if (this.state === 'select') {
      const touch = this.primaryTouch(event.touches);
      if (!touch) return;
      this.selection.update(this.resolveTerminal(), touch.clientX, touch.clientY);
      preventIfCancelable(event);
      return;
    }

    if (this.state === 'wheel') {
      const terminal = this.resolveTerminal();
      this.scroll.handleWheelMove(terminal, event.touches, this.touchStartX);
      preventIfCancelable(event);
      return;
    }

    const touch = this.primaryTouch(event.touches);
    if (!touch) return;

    if (this.state === 'pending') {
      if (!exceedsMoveTolerance(this.touchStartX, this.touchStartY, touch.clientX, touch.clientY)) {
        return;
      }
      // 触摸端不再把单指升级成 TUI 拖拽（press + 流式 motion）：iOS 上单指必须是滚动，
      // 与原生文本 App 一致。上报模式下滚动同样走 handleViewportGesture（终端编码成滚轮
      // 64/65），TUI 里的框选交给长按本地选择。
      this.state = 'scroll';
    }

    // state === 'scroll' | 'pan'：单指滚动/平移路径（上报/非上报共用）
    this.handleSingleFingerMove(touch, event);
  };

  private handleSingleFingerMove(touch: TouchPoint, event: TouchEvent): void {
    if (
      this.selection.isArmed() &&
      exceedsMoveTolerance(this.touchStartX, this.touchStartY, touch.clientX, touch.clientY)
    ) {
      this.selection.clear();
    }

    // 滚动途中划入滚动条热区：交还原生（上报态只认真正的滚动条元素，见 bypasses）。
    // 长按定时器必须一并解除：bypass 后 move 直接 return，定时器若仍武装会在原生
    // 滚动条拖拽途中翻成 select 态并起本地选择。
    if (this.bypasses(touch.clientX, touch.clientY, event.target)) {
      this.selection.clear();
      this.state = 'bypass';
      this.scroll.resetAccumulator();
      return;
    }

    // 先平移、余量再滚 scrollback：纵向到边时两者在同一次 move 里接力（嵌套滚动语义）。
    const panOutcome = this.applyPan(touch, this.scroll.takeVerticalDelta(touch.clientY));
    if (panOutcome.panned) {
      this.state = 'pan';
    }
    if (panOutcome.remainingY === 0) {
      if (panOutcome.panned) {
        preventIfCancelable(event);
      }
      return;
    }

    const outcome = this.scroll.applyVerticalDelta(
      this.resolveTerminal,
      panOutcome.remainingY,
      touch.clientX,
      touch.clientY
    );
    if (!outcome || !event.cancelable) return;

    if (outcome.didScroll || outcome.atTopWhilePullingDown) {
      event.preventDefault();
    }
  }

  readonly handleTouchEnd = (event: TouchEvent): void => {
    // wheel 态触点减少但未清零：重锚质心继续
    if (this.state === 'wheel' && event.touches.length > 0) {
      this.scroll.anchorWheel(event.touches);
      return;
    }

    if (this.state === 'pending') {
      // preventDefault 抑制 compat mouse 序列（规范保证），软键盘由显式 focus 唤起
      const terminal = this.resolveTerminal();
      this.mouseReport.tap(terminal, this.touchStartX, this.touchStartY);
      terminal?.noteTouchHandled?.();
      terminal?.focus?.();
      preventIfCancelable(event);
      this.resetGesture();
      return;
    }

    if (this.state === 'select') {
      const terminal = this.resolveTerminal();
      this.selection.end(terminal);
      // 抑制合成 mousedown：否则它会命中鼠标上报/本地选择分支，清掉刚建立的选择
      terminal?.noteTouchHandled?.();
      preventIfCancelable(event);
      this.resetGesture();
      return;
    }

    if (
      this.state === 'scroll' ||
      this.state === 'pan' ||
      this.state === 'bypass' ||
      this.state === 'wheel'
    ) {
      if (event.touches.length === 0) {
        this.resetGesture();
      }
      return;
    }

    this.resetGesture();
  };

  readonly handleTouchCancel = (event: TouchEvent): void => {
    if (this.state === 'select') {
      const terminal = this.resolveTerminal();
      this.selection.end(terminal);
      terminal?.noteTouchHandled?.();
    }
    if (event.touches.length === 0) {
      this.resetGesture();
    }
  };

  readonly handleContextMenu = (event: Event): void => {
    if (this.state === 'select') {
      event.preventDefault();
    }
  };
}
