// 路由 pane 与会话/草稿的一致性判定：纯函数，供 state 层与派生态共用。

export interface RouteTarget {
  deviceId: string | null;
  paneId: string | null;
}

export interface PaneBound {
  deviceId: string | null;
  paneId: string | null;
}

/** 改绑只能改 paneId（后端 PATCH 不接受 deviceId），跨设备的路由 pane 不可绑定 */
export function canRebindToRoute(
  session: PaneBound | undefined | null,
  route: RouteTarget
): boolean {
  if (!session?.deviceId || !route.deviceId || !route.paneId) return false;
  if (session.deviceId !== route.deviceId) return false;
  return session.paneId !== route.paneId;
}

/** 草稿仍绑在旧 pane 上（路由已切走）：需要按当前路由重新起草，否则发送会落到上一个 pane */
export function shouldRedraftForRoute(
  draft: PaneBound | null,
  route: RouteTarget,
  hasActiveSession: boolean
): boolean {
  if (!draft || hasActiveSession) return false;
  if (!route.deviceId || !route.paneId) return false;
  return draft.deviceId !== route.deviceId || draft.paneId !== route.paneId;
}
