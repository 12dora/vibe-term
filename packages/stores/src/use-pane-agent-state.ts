import type { AgentState } from './agent';
import { isSessionOnNode } from './agent-session-map';

export type PaneAgentState = 'none' | 'bound' | 'generating';

/**
 * 给定 node 上的 deviceId + paneId 是否有活跃 agent session 绑定。
 * - 'none'：无 session 或 session 状态为 stopped/error
 * - 'bound'：session 状态为 idle 或 waiting_confirmation
 * - 'generating'：session 状态为 running（流式输出中）
 *
 * 会话表是**全 mesh 一份**（都由 entry 网关持有），所以必须按 nodeId 过滤：
 * 不同 node 上的 pane id 会重复，不过滤就会拿别的 node 的会话点亮本 node 的徽标。
 */
export function selectPaneAgentState(
  state: AgentState,
  deviceId: string,
  paneId: string,
  nodeId: string | null
): PaneAgentState {
  for (const session of Object.values(state.sessions)) {
    if (!session || session.deviceId !== deviceId || session.paneId !== paneId) continue;
    if (!isSessionOnNode(session, nodeId)) continue;
    if (session.status === 'stopped' || session.status === 'error') continue;
    return session.status === 'running' ? 'generating' : 'bound';
  }
  return 'none';
}
