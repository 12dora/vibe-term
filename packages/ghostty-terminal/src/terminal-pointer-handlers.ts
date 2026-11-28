import {
  beginPointerGesture,
  endPointerGesture,
  isPointerDragActive,
  movePointerGesture,
} from './terminal-pointer-gesture';
import { clearLinkHover, updateLinkHover } from './terminal-pointer-links';
import type { PointerEventContext } from './terminal-pointer-shared';

export type PointerListeners = {
  click: () => void;
  mousedown: (event: MouseEvent) => void;
  mousemove: (event: MouseEvent) => void;
  mouseleave: () => void;
  wheel: (event: WheelEvent) => void;
  dragMove: (event: MouseEvent) => void;
  dragUp: (event: MouseEvent) => void;
};

function focusIfEnabled(context: PointerEventContext): void {
  if (!context.isInputDisabled()) {
    context.focusTerminal();
  }
}

// 触摸手势消费过的那次点按，浏览器随后仍会合成一整套鼠标事件。它们必须整体作废：
// 合成 click 会聚焦 helper textarea（触屏上等于弹软键盘），合成 mousedown 的默认动作
// 又会把焦点从 textarea 上夺走（键盘闪收）。触屏的焦点由手势机显式决定。
function isSyntheticAfterTouch(context: PointerEventContext): boolean {
  return Date.now() < context.mouse.suppressSyntheticUntil;
}

function createClickListener(context: PointerEventContext): () => void {
  return (): void => {
    if (isSyntheticAfterTouch(context)) {
      return;
    }
    focusIfEnabled(context);
  };
}

function createMousedownListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    if (!(event instanceof MouseEvent)) {
      return;
    }
    // 触摸手势刚被 useMobileTouch 消费过：忽略浏览器随后合成的鼠标事件，
    // 防止 tap 双触发与"合成 mousedown 清掉长按选择"（不查 isTrusted，保证测试可驱动）。
    // 同时吃掉默认动作——否则浏览器会把焦点移出 helper textarea，正在显示的软键盘被收起。
    if (isSyntheticAfterTouch(context)) {
      event.preventDefault();
      return;
    }
    context.showScrollbarTransient();
    focusIfEnabled(context);

    beginPointerGesture(context, event);
  };
}

function createMousemoveListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    if (!(event instanceof MouseEvent) || isPointerDragActive(context.mouse)) {
      return;
    }
    context.showScrollbarTransient();
    const mouseReporting = context.getInputRoutingState().mouseReporting;
    // 1003 any-event tracking：裸悬停也上报 motion（无按钮 → SGR code 35），
    // 事件量由同 cell 去重约束；Shift 按住时与点击/拖拽一致交还本地（xterm 约定）
    if (mouseReporting && context.isAnyEventTrackingEnabled() && !event.shiftKey) {
      context.emitMouseInput({
        action: 'motion',
        button: null,
        clientX: event.clientX,
        clientY: event.clientY,
        mods: context.pointerMods(event),
        anyButtonPressed: false,
      });
    }
    updateLinkHover(context, event);
  };
}

function createMouseleaveListener(context: PointerEventContext): () => void {
  return (): void => {
    clearLinkHover(context);
  };
}

function createWheelListener(context: PointerEventContext): (event: WheelEvent) => void {
  return (event: WheelEvent): void => {
    context.showScrollbarTransient();
    const consumed = context.handleViewportGesture({
      source: 'wheel',
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      clientX: event.clientX,
      clientY: event.clientY,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    });
    if (consumed) {
      event.preventDefault();
    }
  };
}

function createDragMoveListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    if (isPointerDragActive(context.mouse)) {
      movePointerGesture(context, event);
    }
  };
}

function createDragUpListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    const mouse = context.mouse;
    if (!isPointerDragActive(mouse) || Date.now() < mouse.suppressSyntheticUntil) {
      return;
    }
    endPointerGesture(context, event);
  };
}

export function createPointerListeners(context: PointerEventContext): PointerListeners {
  return {
    click: createClickListener(context),
    mousedown: createMousedownListener(context),
    mousemove: createMousemoveListener(context),
    mouseleave: createMouseleaveListener(context),
    wheel: createWheelListener(context),
    dragMove: createDragMoveListener(context),
    dragUp: createDragUpListener(context),
  };
}
