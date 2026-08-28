import { hasPlatformModifier } from './selection-clipboard';
import type { PointerEventContext } from './terminal-pointer';
import { mouseButtonFromButtons, mouseButtonFromEvent } from './terminal-pointer';

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

// xterm 约定：Shift+左键绕过鼠标上报、走本地文本选择（上报 TUI 下唯一的复制入口）。
// 返回 true 表示该 mousedown 已被上报路径消费，后续本地逻辑不再执行。
function consumeReportingMousedown(context: PointerEventContext, event: MouseEvent): boolean {
  const reporting = context.getInputRoutingState().mouseReporting;
  if (reporting && event.shiftKey && event.button === 0) {
    context.mouse.reportBypassed = true;
    return false;
  }
  if (!reporting) {
    return false;
  }

  const button = mouseButtonFromEvent(event);
  if (button === null) {
    return true;
  }

  context.clearSelection();
  context.mouse.pressedButtons.add(button);
  context.mouse.dragActive = true;
  context.emitMouseInput({
    action: 'press',
    button,
    clientX: event.clientX,
    clientY: event.clientY,
    mods: context.pointerMods(event),
    anyButtonPressed: true,
  });
  event.preventDefault();
  return true;
}

// 带平台主修饰键(Mac Cmd / 其它 Ctrl)点击链接 → 打开，不进入文本选择。
// 调用点位于上报分支之后，鼠标上报应用(vim/htop)优先，不误触发。
function consumeLinkMousedown(context: PointerEventContext, event: MouseEvent): boolean {
  if (event.button !== 0 || !hasPlatformModifier(event)) {
    return false;
  }
  const hit = context.linkAtClient(event.clientX, event.clientY);
  if (!hit) {
    return false;
  }

  context.activateLink(hit);
  event.preventDefault();
  return true;
}

function createClickListener(context: PointerEventContext): () => void {
  return (): void => {
    focusIfEnabled(context);
  };
}

function createMousedownListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    if (!(event instanceof MouseEvent)) {
      return;
    }
    // 触摸手势刚被 useMobileTouch 消费过：忽略浏览器随后合成的鼠标事件，
    // 防止 tap 双触发与"合成 mousedown 清掉长按选择"（不查 isTrusted，保证测试可驱动）
    if (Date.now() < context.mouse.suppressSyntheticUntil) {
      return;
    }
    context.showScrollbarTransient();
    focusIfEnabled(context);

    if (consumeReportingMousedown(context, event) || consumeLinkMousedown(context, event)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }

    context.mouse.dragActive = true;
    context.beginPointerSelection(event);
    event.preventDefault();
  };
}

function createMousemoveListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    if (!(event instanceof MouseEvent) || context.mouse.dragActive) {
      return;
    }
    context.showScrollbarTransient();
    if (context.getInputRoutingState().mouseReporting) {
      context.setLinkCursor(false);
      // 1003 any-event tracking：裸悬停也上报 motion（无按钮 → SGR code 35），
      // 事件量由同 cell 去重约束；Shift 按住时与点击/拖拽一致交还本地（xterm 约定）
      if (context.isAnyEventTrackingEnabled() && !event.shiftKey) {
        context.emitMouseInput({
          action: 'motion',
          button: null,
          clientX: event.clientX,
          clientY: event.clientY,
          mods: context.pointerMods(event),
          anyButtonPressed: false,
        });
      }
      return;
    }
    // 仅在按住修饰键时扫描链接，普通移动只做一次廉价的修饰键判断。
    context.setLinkCursor(
      hasPlatformModifier(event) && context.linkAtClient(event.clientX, event.clientY) !== null
    );
  };
}

function createMouseleaveListener(context: PointerEventContext): () => void {
  return (): void => {
    context.setLinkCursor(false);
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
    if (!context.mouse.dragActive) {
      return;
    }
    if (context.getInputRoutingState().mouseReporting && !context.mouse.reportBypassed) {
      context.emitMouseInput({
        action: 'motion',
        button: mouseButtonFromButtons(event.buttons),
        clientX: event.clientX,
        clientY: event.clientY,
        mods: context.pointerMods(event),
        anyButtonPressed: context.mouse.pressedButtons.size > 0 || event.buttons > 0,
      });
      return;
    }
    // 拖到窗口外松开时 mouseup 不会派发，拖拽会连同自动滚动一直挂着：
    // 下一次没有按键的 mousemove 即视为本次拖拽已结束。
    if (event.buttons === 0) {
      context.mouse.dragActive = false;
      context.finishPointerSelection(event);
      return;
    }
    context.updatePointerSelection(event);
  };
}

function createDragUpListener(context: PointerEventContext): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    const mouse = context.mouse;
    if (!mouse.dragActive || Date.now() < mouse.suppressSyntheticUntil) {
      return;
    }
    mouse.dragActive = false;
    const bypassed = mouse.reportBypassed;
    mouse.reportBypassed = false;
    if (context.getInputRoutingState().mouseReporting && !bypassed) {
      const button = mouseButtonFromEvent(event);
      if (button !== null) {
        mouse.pressedButtons.delete(button);
      }
      context.emitMouseInput({
        action: 'release',
        button,
        clientX: event.clientX,
        clientY: event.clientY,
        mods: context.pointerMods(event),
        anyButtonPressed: mouse.pressedButtons.size > 0,
      });
      return;
    }
    context.finishPointerSelection(event);
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
