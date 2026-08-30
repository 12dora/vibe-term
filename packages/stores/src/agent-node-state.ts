// agent 视图状态的 node 分片：活动会话与草稿按 node 各存一份。
//
// 会话表是全 mesh 共享的一份（都由 entry 网关持有），但「当前选中哪个会话」「未发送的草稿」
// 是每个 node 各自的视图状态：路由在 node 之间切换只该换当前视图，不该把别的 node 的选择
// 或草稿清掉。

import { SELF_NODE_ID } from '@tmex/api-client';
import { isSessionOnNode, normalizeAgentNodeId } from './agent-session-map';
import type { AgentStateData, DraftSession } from './agent-state';

/** 分片键：entry 自身（`null` / `self`）统一落在 `self` 上。 */
export function agentNodeKey(nodeId: string | null | undefined): string {
  return normalizeAgentNodeId(nodeId) ?? SELF_NODE_ID;
}

/**
 * 该 node 上的活动会话。会话已被别端删除，或（持久化恢复后）实际绑在别的 node 上时
 * 视为未选中——否则会拿别人的会话内容填这个 node 的面板。
 */
export function activeSessionIdOnNode(state: AgentStateData, nodeId: string | null): string | null {
  const sessionId = state.activeSessionIdByNode[agentNodeKey(nodeId)] ?? null;
  if (!sessionId) return null;
  const session = state.sessions[sessionId];
  return session && isSessionOnNode(session, nodeId) ? sessionId : null;
}

export function draftOnNode(state: AgentStateData, nodeId: string | null): DraftSession | null {
  return state.draftByNode[agentNodeKey(nodeId)] ?? null;
}

export function isDraftMaterializingOnNode(state: AgentStateData, nodeId: string | null): boolean {
  return state.materializingDraftByNode[agentNodeKey(nodeId)] ?? false;
}

/** 各 node 当前选中的会话 id（重连重放订阅与补史时遍历用）。 */
export function activeSessionIds(state: AgentStateData): string[] {
  return Object.values(state.activeSessionIdByNode).filter((id): id is string => Boolean(id));
}
