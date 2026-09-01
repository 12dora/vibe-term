// 视口仲裁策略：一个 tmux pane 只有一个 PTY，整窗尺寸归「当前可见且最大」的客户端所有。
// 网关按窗口选出 owner 后向每个持有声明的会话下发 terminal-viewport-policy，
// 这里只负责把它按 pane 存起来供 Terminal 决定 sizingMode。

export interface PaneViewportPolicy {
  /** 本客户端的几何是否即当前生效的整窗尺寸 */
  owner: boolean;
  cols: number;
  rows: number;
  /** 策略实际作用的 tmux window（网关按窗口仲裁） */
  windowId: string;
}

export type ViewportPolicyMap = Record<string, PaneViewportPolicy | undefined>;

export interface ViewportPolicyEvent {
  deviceId: string;
  windowId: string;
  paneId: string;
  owner: boolean;
  cols: number;
  rows: number;
}

export interface ViewportPolicyStateSlice {
  viewportPolicy: ViewportPolicyMap;
}

export function paneViewportKey(deviceId: string, paneId: string): string {
  return `${deviceId}:${paneId}`;
}

function samePolicy(a: PaneViewportPolicy | undefined, b: PaneViewportPolicy): boolean {
  return (
    a !== undefined &&
    a.owner === b.owner &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.windowId === b.windowId
  );
}

/** 应用一条策略事件；内容未变时原样返回，避免无谓的 store 通知 */
export function applyViewportPolicy(
  policies: ViewportPolicyMap,
  event: ViewportPolicyEvent
): ViewportPolicyMap {
  if (!event.deviceId || !event.paneId) return policies;
  const next: PaneViewportPolicy = {
    owner: event.owner,
    cols: event.cols,
    rows: event.rows,
    windowId: event.windowId,
  };
  const key = paneViewportKey(event.deviceId, event.paneId);
  if (samePolicy(policies[key], next)) return policies;
  return { ...policies, [key]: next };
}

/** 设备断开/连接重置：该设备的策略全部作废，回到「默认自己是 owner」 */
export function clearViewportPolicyForDevice(
  policies: ViewportPolicyMap,
  deviceId: string
): ViewportPolicyMap {
  const prefix = `${deviceId}:`;
  const keys = Object.keys(policies).filter((key) => key.startsWith(prefix));
  if (keys.length === 0) return policies;
  const next = { ...policies };
  for (const key of keys) delete next[key];
  return next;
}

export function selectPaneViewportPolicy(
  state: ViewportPolicyStateSlice,
  deviceId: string | undefined,
  paneId: string | undefined
): PaneViewportPolicy | undefined {
  if (!deviceId || !paneId) return undefined;
  return state.viewportPolicy[paneViewportKey(deviceId, paneId)];
}

/** 没收到过策略即视为 owner：单客户端场景与改造前完全一致 */
export function selectPaneViewportOwner(
  state: ViewportPolicyStateSlice,
  deviceId: string | undefined,
  paneId: string | undefined
): boolean {
  return selectPaneViewportPolicy(state, deviceId, paneId)?.owner ?? true;
}
