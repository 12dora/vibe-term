// 触屏轻点终端画布的处置：软键盘只由「输入行」唤起。
//
// 画布上的轻点一律不让浏览器隐式改焦点——它在触摸手势之后合成的那套鼠标事件既会聚焦
// helper textarea（弹键盘），也会反过来把焦点夺走（收键盘），因此整体作废。
// 只有点在光标所在行（含上下各一行容差）才显式聚焦：那是"我要在这里输入"的表达。
// 判定放在纯函数里：手势机只负责喂状态。

export const TERMINAL_SURFACE_SELECTOR = '.xterm';
export const TERMINAL_SCREEN_SELECTOR = '.xterm-screen';
/** 光标行上下各放宽一行，手指按不准也能命中 */
export const CURSOR_ROW_TOLERANCE = 1;

export interface TapFocusIntent {
  /** 本次手势是否越过位移容差；越过即滚动/平移，不再算轻点 */
  moved: boolean;
  /** touchend 的 target（触摸事件的 target 恒为手势起点所在元素） */
  target: unknown;
}

/** 命中终端画布子树（快捷键栏、选区工具条、启动占位这些覆盖层不算） */
export function hitsTerminalSurface(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return false;
  return Boolean(
    (closest as (selector: string) => unknown).call(target, TERMINAL_SURFACE_SELECTOR)
  );
}

/** true = 该 touchend 要 preventDefault + noteTouchHandled，压掉后续合成鼠标序列 */
export function shouldSuppressTapSyntheticMouse(intent: TapFocusIntent): boolean {
  if (intent.moved) return false;
  return hitsTerminalSurface(intent.target);
}

export interface CursorRowSource {
  lastCursor?: { visible: boolean; y: number | null } | null;
  buffer?: { active?: { viewportY?: number; baseY?: number } };
}

/**
 * 光标所在的视口行号；读不到、光标不可见、或已滚回历史（光标行不在屏上）时返回 null。
 * y 取自最近一帧的渲染快照，与画布上看到的完全一致。
 */
export function cursorRowFromTerminal(terminal: CursorRowSource | null | undefined): number | null {
  const cursor = terminal?.lastCursor;
  if (!cursor || !cursor.visible || cursor.y === null || cursor.y === undefined) {
    return null;
  }
  const active = terminal?.buffer?.active;
  if (
    active &&
    typeof active.viewportY === 'number' &&
    typeof active.baseY === 'number' &&
    active.viewportY !== active.baseY
  ) {
    return null;
  }
  return cursor.y;
}

export interface CursorRowTapIntent {
  /** 手势起点的 client y */
  clientY: number;
  /** .xterm-screen 的 client top（与 ghostty hitTest 同一基准，已含平移视口偏移） */
  screenTop: number;
  cellHeight: number;
  cursorRow: number | null;
  tolerance?: number;
}

/** 轻点是否落在光标行（含容差）——落在即视为要输入，显式聚焦唤起软键盘 */
export function tapHitsCursorRow(intent: CursorRowTapIntent): boolean {
  if (intent.cursorRow === null || intent.cellHeight <= 0) {
    return false;
  }
  const row = Math.floor((intent.clientY - intent.screenTop) / intent.cellHeight);
  return Math.abs(row - intent.cursorRow) <= (intent.tolerance ?? CURSOR_ROW_TOLERANCE);
}
