import { hasPlatformModifier } from './selection-clipboard';
import {
  GHOSTTY_MOUSE_BUTTON_LEFT,
  type MouseDownDecision,
  classifyMouseDown,
  isShiftReportingBypass,
  mouseButtonFromButtons,
  mouseButtonFromEvent,
} from './terminal-pointer-policy';
import type { GhosttyViewportGesture } from './types';

export {
  GHOSTTY_MOUSE_BUTTON_LEFT,
  GHOSTTY_MOUSE_BUTTON_MIDDLE,
  GHOSTTY_MOUSE_BUTTON_RIGHT,
  mouseButtonFromButtons,
  mouseButtonFromEvent,
} from './terminal-pointer-policy';

export const GHOSTTY_MOUSE_BUTTON_FOUR = 4;
export const GHOSTTY_MOUSE_BUTTON_FIVE = 5;
export const GHOSTTY_MOUSE_BUTTON_SIX = 6;
export const GHOSTTY_MOUSE_BUTTON_SEVEN = 7;
// 触摸手势消费后的合成鼠标（compat mouse events）抑制窗口
export const SYNTHETIC_MOUSE_SUPPRESS_MS = 500;

export type InputRoutingState = {
  mouseReporting: boolean;
  altScroll: boolean;
};

export type MouseInputState = {
  pressedButtons: Set<number>;
  dragActive: boolean;
  reportBypassed: boolean;
  suppressSyntheticUntil: number;
  lastMotionCell: { col: number; row: number } | null;
};

export type MouseInputRequest = {
  action: 'press' | 'release' | 'motion';
  button?: number | null;
  clientX: number;
  clientY: number;
  mods: number;
  anyButtonPressed: boolean;
};

export type TerminalLinkHit = { kind: 'url'; url: string } | { kind: 'file'; path: string };

export type PointerEventContext = {
  readonly mouse: MouseInputState;
  isInputDisabled(): boolean;
  focusTerminal(): void;
  showScrollbarTransient(): void;
  getInputRoutingState(): InputRoutingState;
  isAnyEventTrackingEnabled(): boolean;
  pointerMods(event: {
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  }): number;
  emitMouseInput(request: MouseInputRequest): boolean;
  clearSelection(): void;
  linkAtClient(clientX: number, clientY: number): TerminalLinkHit | null;
  activateLink(hit: TerminalLinkHit): void;
  setLinkCursor(active: boolean): void;
  beginPointerSelection(event: MouseEvent): void;
  updatePointerSelection(event: MouseEvent): void;
  finishPointerSelection(event: MouseEvent): void;
  handleViewportGesture(gesture: GhosttyViewportGesture): boolean;
};

export function createMouseInputState(): MouseInputState {
  return {
    pressedButtons: new Set<number>(),
    dragActive: false,
    reportBypassed: false,
    suppressSyntheticUntil: 0,
    lastMotionCell: null,
  };
}

export function bindMouseEvents(
  root: HTMLElement,
  selectSurface: HTMLElement,
  context: PointerEventContext
): () => void {
  const mouse = context.mouse;

  const clickListener = (): void => {
    if (!context.isInputDisabled()) {
      context.focusTerminal();
    }
  };

  const resolveMouseDown = (
    event: MouseEvent
  ): { decision: MouseDownDecision; linkHit: TerminalLinkHit | null } => {
    const reporting = context.getInputRoutingState().mouseReporting;
    const button = mouseButtonFromEvent(event);
    const platformModifier = hasPlatformModifier(event);
    const linkHit =
      platformModifier && button === GHOSTTY_MOUSE_BUTTON_LEFT
        ? context.linkAtClient(event.clientX, event.clientY)
        : null;

    return {
      decision: classifyMouseDown({
        reporting,
        shiftBypass: isShiftReportingBypass(reporting, event.shiftKey, button),
        button,
        platformModifier,
        hasLink: linkHit !== null,
      }),
      linkHit,
    };
  };

  const applyMouseDown = (
    event: MouseEvent,
    decision: MouseDownDecision,
    linkHit: TerminalLinkHit | null
  ): void => {
    if (decision.kind === 'report') {
      context.clearSelection();
      mouse.pressedButtons.add(decision.button);
      mouse.dragActive = true;
      context.emitMouseInput({
        action: 'press',
        button: decision.button,
        clientX: event.clientX,
        clientY: event.clientY,
        mods: context.pointerMods(event),
        anyButtonPressed: true,
      });
      event.preventDefault();
      return;
    }

    if (decision.kind === 'activateLink' && linkHit) {
      context.activateLink(linkHit);
      event.preventDefault();
      return;
    }

    if (decision.kind !== 'beginSelection') {
      return;
    }

    mouse.dragActive = true;
    context.beginPointerSelection(event);
    event.preventDefault();
  };

  const mousedownListener = (event: MouseEvent): void => {
    // 触摸手势刚被 useMobileTouch 消费过：忽略浏览器随后合成的鼠标事件，
    // 防止 tap 双触发与"合成 mousedown 清掉长按选择"（不查 isTrusted，保证测试可驱动）
    if (!(event instanceof MouseEvent) || Date.now() < mouse.suppressSyntheticUntil) {
      return;
    }
    context.showScrollbarTransient();

    if (!context.isInputDisabled()) {
      context.focusTerminal();
    }

    const { decision, linkHit } = resolveMouseDown(event);
    if (decision.recordBypass) {
      mouse.reportBypassed = true;
    }
    applyMouseDown(event, decision, linkHit);
  };

  const mousemoveListener = (event: MouseEvent): void => {
    if (!(event instanceof MouseEvent) || mouse.dragActive) {
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

  const mouseleaveListener = (): void => {
    context.setLinkCursor(false);
  };

  const wheelListener = (event: WheelEvent): void => {
    context.showScrollbarTransient();
    if (
      context.handleViewportGesture({
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
      })
    ) {
      event.preventDefault();
    }
  };

  root.addEventListener('click', clickListener);
  selectSurface.addEventListener('mousedown', mousedownListener);
  selectSurface.addEventListener('mousemove', mousemoveListener);
  selectSurface.addEventListener('mouseleave', mouseleaveListener);
  root.addEventListener('wheel', wheelListener, { passive: false });

  const dragEventTarget =
    typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;

  const dragMoveListener = (event: MouseEvent): void => {
    if (!mouse.dragActive) {
      return;
    }
    if (context.getInputRoutingState().mouseReporting && !mouse.reportBypassed) {
      context.emitMouseInput({
        action: 'motion',
        button: mouseButtonFromButtons(event.buttons),
        clientX: event.clientX,
        clientY: event.clientY,
        mods: context.pointerMods(event),
        anyButtonPressed: mouse.pressedButtons.size > 0 || event.buttons > 0,
      });
      return;
    }
    context.updatePointerSelection(event);
  };

  const dragUpListener = (event: MouseEvent): void => {
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

  if (dragEventTarget) {
    dragEventTarget.addEventListener('mousemove', dragMoveListener);
    dragEventTarget.addEventListener('mouseup', dragUpListener);
  }

  return () => {
    root.removeEventListener('click', clickListener);
    selectSurface.removeEventListener('mousedown', mousedownListener);
    selectSurface.removeEventListener('mousemove', mousemoveListener);
    selectSurface.removeEventListener('mouseleave', mouseleaveListener);
    root.removeEventListener('wheel', wheelListener);
    if (dragEventTarget) {
      dragEventTarget.removeEventListener('mousemove', dragMoveListener);
      dragEventTarget.removeEventListener('mouseup', dragUpListener);
    }
  };
}
