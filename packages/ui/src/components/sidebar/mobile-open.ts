/**
 * 移动端抽屉的打开状态。
 *
 * Base UI 的 Dialog 打开时会把焦点移到弹层里第一个可聚焦元素——侧边栏顶上就是「关闭侧边栏」。
 * 用户自己开的抽屉这样没问题；**替用户自动弹出**的那一次（PWA 冷启动落在首页）不该带走焦点，
 * 否则冷启动后左上角一直挂着一圈焦点环。所以打开状态里多带一位：这次打开要不要跳过初始焦点。
 */
export type MobileSidebarState = {
  open: boolean;
  suppressInitialFocus: boolean;
};

export const CLOSED_MOBILE_SIDEBAR: MobileSidebarState = {
  open: false,
  suppressInitialFocus: false,
};

/** 用户自己开 / 关：走默认焦点管理，顺手把自动弹出的标记复位。 */
export function setMobileSidebarOpen(state: MobileSidebarState, open: boolean): MobileSidebarState {
  if (state.open === open && !state.suppressInitialFocus) return state;
  return { open, suppressInitialFocus: false };
}

/** 替用户自动弹出：这一次不移动焦点。重复调用幂等（StrictMode 下 effect 会跑两遍）。 */
export function autoOpenMobileSidebar(state: MobileSidebarState): MobileSidebarState {
  if (state.open && state.suppressInitialFocus) return state;
  return { open: true, suppressInitialFocus: true };
}

/**
 * `SheetContent`（Base UI 的 Dialog Popup）的 `initialFocus`：
 * `false` = 打开时不移动焦点；`undefined` = 交回 Base UI 的默认行为（触摸打开聚焦弹层本身，
 * 其余聚焦第一个可聚焦元素）。
 */
export function mobileSheetInitialFocus(state: MobileSidebarState): false | undefined {
  return state.suppressInitialFocus ? false : undefined;
}
