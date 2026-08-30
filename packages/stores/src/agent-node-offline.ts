// node 离线时的会话暂停判定：纯函数，agent 面板与侧边栏会话行共用。

/** node 离线传播时后端写入会话的 lastError */
export const NODE_OFFLINE_ERROR = 'NODE_OFFLINE';

/**
 * 会话是否处于「离线暂停」：mesh 状态是权威信号，node 回到在线即恢复输入
 * （会话本身仍停在 error，由用户下一次发送清除）。宿主拿不到 mesh 状态（standalone、
 * 列表尚未加载）时才退回用会话上的 NODE_OFFLINE 兜底。
 */
export function isNodePaused(
  nodeOffline: boolean | undefined,
  lastError: string | null | undefined
): boolean {
  if (nodeOffline !== undefined) return nodeOffline;
  return lastError === NODE_OFFLINE_ERROR;
}
