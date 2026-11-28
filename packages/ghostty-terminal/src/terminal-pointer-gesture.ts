// 鼠标手势状态的唯一属主：主键手势（mouse.primary）、已上报按键（pressedButtons）与待定链接
// 只在这里改写。不变式：
// - 只对上报过 press 的按键上报 release / 带按键的 motion，绝不发孤立事件；
// - 丢失的 mouseup 在下一次任意按下/移动/松开时按 event.buttons 收尾（补发 release / 结束选区）；
// - 没有按键按下时 isPointerDragActive 为 false。
import {
  linkPressAction,
  linkReleaseOpens,
  pendingLinkSurvivesMove,
} from './terminal-pointer-links';
import {
  GHOSTTY_MOUSE_BUTTON_LEFT,
  GHOSTTY_MOUSE_BUTTON_MIDDLE,
  GHOSTTY_MOUSE_BUTTON_RIGHT,
  type MouseInputRequest,
  type MouseInputState,
  type PointerEventContext,
  mouseButtonFromEvent,
} from './terminal-pointer-shared';

// 同时按着多个上报键时 motion 带哪一个：与 xterm 一致左 > 中 > 右。
const REPORTED_BUTTON_ORDER = [
  GHOSTTY_MOUSE_BUTTON_LEFT,
  GHOSTTY_MOUSE_BUTTON_MIDDLE,
  GHOSTTY_MOUSE_BUTTON_RIGHT,
];

const PRIMARY_BUTTONS_BIT = 1;

// MouseEvent.button → MouseEvent.buttons 位（中键与右键的位序与 button 编号相反）。
function domButtonsBit(button: number): number {
  if (button === 1) {
    return 4;
  }
  if (button === 2) {
    return 2;
  }
  return 1 << button;
}

function ghosttyButtonsBit(button: number): number {
  if (button === GHOSTTY_MOUSE_BUTTON_MIDDLE) {
    return 4;
  }
  if (button === GHOSTTY_MOUSE_BUTTON_RIGHT) {
    return 2;
  }
  return PRIMARY_BUTTONS_BIT;
}

export function isPointerDragActive(mouse: MouseInputState): boolean {
  return mouse.primary !== 'none' || mouse.pressedButtons.size > 0;
}

/** 应用关闭鼠标跟踪时调用：已上报的按键与链接手势作废（不补发 release），本地选区不受影响。 */
export function resetReportedPointerGesture(mouse: MouseInputState): void {
  mouse.pressedButtons.clear();
  mouse.pendingLink = null;
  if (mouse.primary !== 'selection') {
    mouse.primary = 'none';
  }
}

/** 终端整体 reset（快照重写）时调用：选区已由宿主清掉，手势状态全部归零，不补发 release。 */
export function resetPointerGesture(mouse: MouseInputState): void {
  mouse.pressedButtons.clear();
  mouse.pendingLink = null;
  mouse.primary = 'none';
}

function emitButton(
  context: PointerEventContext,
  event: MouseEvent,
  action: MouseInputRequest['action'],
  button: number,
  anyButtonPressed = context.mouse.pressedButtons.size > 0
): boolean {
  return context.emitMouseInput({
    action,
    button,
    clientX: event.clientX,
    clientY: event.clientY,
    mods: context.pointerMods(event),
    anyButtonPressed,
  });
}

// 只有真正发出去的 press 才记入 pressedButtons（输入关闭 / 坐标超出编码范围时不发），
// 否则之后会对应用发出孤立的 motion / release。
function pressReported(context: PointerEventContext, event: MouseEvent, button: number): void {
  context.clearSelection();
  if (emitButton(context, event, 'press', button, true)) {
    context.mouse.pressedButtons.add(button);
  }
  event.preventDefault();
}

function releaseReported(context: PointerEventContext, event: MouseEvent, button: number): void {
  if (context.mouse.pressedButtons.delete(button)) {
    emitButton(context, event, 'release', button);
  }
}

// held 为此刻物理上仍按着的 buttons 位掩码：不在其中的手势与上报键视为 mouseup 丢失，就地收尾。
function settleLostReleases(context: PointerEventContext, event: MouseEvent, held: number): void {
  const mouse = context.mouse;
  if (mouse.primary !== 'none' && (held & PRIMARY_BUTTONS_BIT) === 0) {
    const primary = mouse.primary;
    mouse.primary = 'none';
    mouse.pendingLink = null;
    if (primary === 'selection') {
      context.finishPointerSelection(event);
    }
  }
  for (const button of [...mouse.pressedButtons]) {
    if ((held & ghosttyButtonsBit(button)) === 0) {
      releaseReported(context, event, button);
    }
  }
}

function beginPrimary(context: PointerEventContext, event: MouseEvent): void {
  const mouse = context.mouse;
  const link = linkPressAction(context, event);
  if (link?.kind === 'open') {
    mouse.primary = 'opened';
    context.activateLink(link.hit);
    event.preventDefault();
    return;
  }
  mouse.pendingLink = link?.pending ?? null;
  if (link?.swallow) {
    mouse.primary = 'swallowed';
    event.preventDefault();
    return;
  }
  // xterm 约定：Shift+左键绕过鼠标上报、走本地文本选择（上报 TUI 下唯一的复制入口）。
  if (context.getInputRoutingState().mouseReporting && !event.shiftKey) {
    mouse.primary = 'reported';
    pressReported(context, event, GHOSTTY_MOUSE_BUTTON_LEFT);
    return;
  }
  mouse.primary = 'selection';
  context.beginPointerSelection(event);
  event.preventDefault();
}

export function beginPointerGesture(context: PointerEventContext, event: MouseEvent): void {
  // 正在按下的这个键此前必然已抬起：它的旧记录一并收尾。
  settleLostReleases(context, event, event.buttons & ~domButtonsBit(event.button));
  if (event.button === 0) {
    beginPrimary(context, event);
    return;
  }
  // Shift 绕过上报的本地选区期间，整次手势都不上报：其它键按下不打断选区。
  if (context.mouse.primary === 'selection') {
    return;
  }
  const button = mouseButtonFromEvent(event);
  if (button !== null && context.getInputRoutingState().mouseReporting) {
    pressReported(context, event, button);
  }
}

export function movePointerGesture(context: PointerEventContext, event: MouseEvent): void {
  const mouse = context.mouse;
  if (mouse.pendingLink && !pendingLinkSurvivesMove(context, event, mouse.pendingLink)) {
    mouse.pendingLink = null;
  }
  settleLostReleases(context, event, event.buttons);
  if (mouse.primary === 'selection') {
    context.updatePointerSelection(event);
    return;
  }
  const button = REPORTED_BUTTON_ORDER.find((candidate) => mouse.pressedButtons.has(candidate));
  if (button !== undefined && context.getInputRoutingState().mouseReporting) {
    emitButton(context, event, 'motion', button);
  }
}

// 主键松开：被吞/修饰键打开的手势静默结束；本地模式下打开的链接不留下选区。
function endPrimary(context: PointerEventContext, event: MouseEvent): void {
  const mouse = context.mouse;
  const { primary, pendingLink } = mouse;
  mouse.primary = 'none';
  mouse.pendingLink = null;
  const opens = pendingLink !== null && linkReleaseOpens(context, event, pendingLink);
  if (primary === 'reported') {
    releaseReported(context, event, GHOSTTY_MOUSE_BUTTON_LEFT);
  } else if (primary === 'selection') {
    if (opens) {
      context.clearSelection();
    } else {
      context.finishPointerSelection(event);
    }
  }
  if (opens) {
    context.activateLink(pendingLink.hit);
    event.preventDefault();
  }
}

export function endPointerGesture(context: PointerEventContext, event: MouseEvent): void {
  if (event.button === 0) {
    endPrimary(context, event);
  } else {
    const button = mouseButtonFromEvent(event);
    if (button !== null) {
      releaseReported(context, event, button);
    }
  }
  settleLostReleases(context, event, event.buttons);
}
