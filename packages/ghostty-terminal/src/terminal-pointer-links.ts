// 鼠标侧的链接判定：按下（修饰键立即打开 / 无修饰记下待定链接）、拖动取消、松开打开、悬停光标。
// 是否打开一律交给 shouldOpenLink；这里只做判定，手势状态由 terminal-pointer-gesture 统一改写。
import { classifyLinkModifiers, shouldOpenLink } from './link-open-policy';
import type {
  PendingLinkClick,
  PointerEventContext,
  TerminalCellPoint,
  TerminalLinkHit,
} from './terminal-pointer-shared';

function isSameCell(a: TerminalCellPoint, b: TerminalCellPoint | null): boolean {
  return b !== null && a.line === b.line && a.col === b.col;
}

/** 与 openLinkAt 同一口径：输入关闭（只读视图）时鼠标从不上报给应用，按上报关闭判定。 */
export function effectiveMouseReporting(context: PointerEventContext): boolean {
  return !context.isInputDisabled() && context.getInputRoutingState().mouseReporting;
}

export type LinkPressAction =
  | { kind: 'open'; hit: TerminalLinkHit }
  // pending 为 null 表示双击的后续按下：不再等待打开，但上报模式下仍整体吞掉
  | { kind: 'pending'; pending: PendingLinkClick | null; swallow: boolean };

// 主键按下落在链接上时该怎么处理；null 表示与链接无关，交还上报/选区逻辑。
// 修饰键点击与上报模式下的 OSC 8 链接都优先于应用的鼠标上报。
export function linkPressAction(
  context: PointerEventContext,
  event: MouseEvent
): LinkPressAction | null {
  const modifiers = classifyLinkModifiers(event);
  const mouseReporting = effectiveMouseReporting(context);
  const hit = context.linkAtClient(event.clientX, event.clientY);
  if (!hit) {
    return null;
  }
  if (shouldOpenLink({ hit, trigger: 'press', mouseReporting, modifiers })) {
    return { kind: 'open', hit };
  }
  const point = context.cellAtClient(event.clientX, event.clientY);
  if (!point || !shouldOpenLink({ hit, trigger: 'release', mouseReporting, modifiers })) {
    return null;
  }
  return {
    kind: 'pending',
    pending: event.detail < 2 ? { ...point, hit } : null,
    // 吞掉与否看应用是否开了上报（不看输入是否关闭）：只读视图下上报分支同样会吃掉这次按下。
    swallow: context.getInputRoutingState().mouseReporting,
  };
}

// 拖动离开按下的格子或主键已抬起：待定链接作废。
export function pendingLinkSurvivesMove(
  context: PointerEventContext,
  event: MouseEvent,
  pending: PendingLinkClick
): boolean {
  return (
    (event.buttons & 1) !== 0 &&
    isSameCell(pending, context.cellAtClient(event.clientX, event.clientY))
  );
}

// 主键松开：同一格、非双击、策略仍允许时打开。
export function linkReleaseOpens(
  context: PointerEventContext,
  event: MouseEvent,
  pending: PendingLinkClick
): boolean {
  return (
    event.detail < 2 &&
    isSameCell(pending, context.cellAtClient(event.clientX, event.clientY)) &&
    shouldOpenLink({
      hit: pending.hit,
      trigger: 'release',
      mouseReporting: effectiveMouseReporting(context),
      modifiers: classifyLinkModifiers(event),
    })
  );
}

// 悬停：光标为「此刻点击会打开」，按住平台修饰键时任一链接都是 pointer；title 只给
// 可见文本与 URI 不同的 OSC 8 url。mousemove 是热路径：格子与修饰键状态不变就不重算。
export function updateLinkHover(context: PointerEventContext, event: MouseEvent): void {
  const mouse = context.mouse;
  const point = context.cellAtClient(event.clientX, event.clientY);
  const modifiers = classifyLinkModifiers(event);
  const mouseReporting = effectiveMouseReporting(context);
  const last = mouse.linkHover;
  if (
    last &&
    isSameCell(last, point) &&
    last.platform === modifiers.platform &&
    last.other === modifiers.other &&
    last.shift === modifiers.shift &&
    last.reporting === mouseReporting
  ) {
    return;
  }

  mouse.linkHover = point ? { ...point, ...modifiers, reporting: mouseReporting } : null;
  const hit = point ? context.linkAtClient(event.clientX, event.clientY) : null;
  const opens = shouldOpenLink({ hit, trigger: 'hover', mouseReporting, modifiers });
  context.setLinkCursor(opens, hit?.tooltip ?? null);
}

export function clearLinkHover(context: PointerEventContext): void {
  context.mouse.linkHover = null;
  context.setLinkCursor(false, null);
}
