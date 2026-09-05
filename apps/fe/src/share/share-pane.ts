// 分享 window 里当前该显示哪个 pane 的纯判定。

export interface SharePaneLike {
  id: string;
}

/** 查询参数点名的 pane 仍在窗口里就用它，否则回落到第一个 pane。 */
export function resolveSharePaneId(
  panes: readonly SharePaneLike[] | undefined,
  requested: string | null | undefined
): string | undefined {
  if (requested && panes?.some((pane) => pane.id === requested)) return requested;
  return panes?.[0]?.id;
}
