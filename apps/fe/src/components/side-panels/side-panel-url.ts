// 右侧滑出面板的 URL 协议：`?panel=<name>`。
//
// 面板状态挂在查询串而不是组件 state，图的是三件事：任意路由（含 `/n/:nodeId/...`）都能开、
// 可以直接分享链接、移动端的返回键能关掉它。除 `panel` 外的查询参数一律原样保留。

export const SIDE_PANEL_PARAM = 'panel';

export const SIDE_PANEL_NAMES = ['nodes', 'security'] as const;

export type SidePanelName = (typeof SIDE_PANEL_NAMES)[number];

export function parseSidePanel(value: string | null | undefined): SidePanelName | null {
  return SIDE_PANEL_NAMES.includes(value as SidePanelName) ? (value as SidePanelName) : null;
}

/** 在现有查询串上设置 / 清除 `panel`，其余参数保持不变。 */
export function nextSidePanelParams(
  current: URLSearchParams,
  name: SidePanelName | null
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (name) next.set(SIDE_PANEL_PARAM, name);
  else next.delete(SIDE_PANEL_PARAM);
  return next;
}

/**
 * 给 `<Link to>` 用的相对目标：只带查询串，react-router 会补上当前 pathname，
 * 所以同一个入口在任何页面上都指向「当前页 + 该面板」。
 */
export function sidePanelHref(current: URLSearchParams, name: SidePanelName): string {
  return `?${nextSidePanelParams(current, name).toString()}`;
}
