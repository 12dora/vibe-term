// 触屏轻点终端画布的处置：软键盘只由输入入口（快捷键栏的「显示键盘」）唤起。
// 画布上的轻点既不能聚焦 helper textarea（弹键盘），也不能把它已有的焦点夺走（收键盘），
// 而这两件事都由浏览器在触摸手势之后合成的鼠标序列完成——所以轻点要把这套序列整体作废。
// 判定放在纯函数里：手势机只负责喂状态。

export const TERMINAL_SURFACE_SELECTOR = '.xterm';

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
