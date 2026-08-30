import { type SessionMap, isSessionOnNode, normalizeAgentNodeId } from './agent-session-map';
import type { AgentState } from './agent-state';

export type PaneAgentState = 'none' | 'bound' | 'generating';

const PANE_KEY_SEPARATOR = '\u0000';

function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}${PANE_KEY_SEPARATOR}${paneId}`;
}

/**
 * 一份 sessions 下按 node 各建一次的 `device:pane -> 徽标态` 索引。
 *
 * 每个挂载的 pane 都有一个徽标选择器，而 store 的任何 set（含 40ms 一次的流式 delta flush）
 * 都会重跑全部选择器：逐个线性扫会话表就是 O(pane × session)。sessions 的所有写入路径都是
 * `{ ...prev.sessions }` 整体替换（见 agent-session-map / agent-event-router），
 * 因此可以按其引用缓存索引：会话表没变就一直复用，单次重建后每个 pane 都是 O(1) 查表。
 */
const paneStateCache = new WeakMap<SessionMap, Map<string, Map<string, PaneAgentState>>>();

function buildPaneStateIndex(sessions: SessionMap, nodeId: string | null) {
  const index = new Map<string, PaneAgentState>();
  for (const session of Object.values(sessions)) {
    if (!session?.deviceId || !session.paneId) continue;
    if (!isSessionOnNode(session, nodeId)) continue;
    if (session.status === 'stopped' || session.status === 'error') continue;
    const key = paneKey(session.deviceId, session.paneId);
    // 同一 pane 可绑多个会话：只要有一个在流式输出就算 generating，不受会话插入顺序影响
    if (session.status === 'running') index.set(key, 'generating');
    else if (!index.has(key)) index.set(key, 'bound');
  }
  return index;
}

function paneStateIndex(sessions: SessionMap, nodeId: string | null) {
  let byNode = paneStateCache.get(sessions);
  if (!byNode) {
    byNode = new Map();
    paneStateCache.set(sessions, byNode);
  }
  // `self` 与 null 同义，归一后共用一份索引
  const cacheKey = normalizeAgentNodeId(nodeId) ?? '';
  let index = byNode.get(cacheKey);
  if (!index) {
    index = buildPaneStateIndex(sessions, nodeId);
    byNode.set(cacheKey, index);
  }
  return index;
}

/**
 * 给定 node 上的 deviceId + paneId 是否有活跃 agent session 绑定。
 * - 'none'：无 session 或 session 状态均为 stopped/error
 * - 'bound'：有活跃 session（idle 或 waiting_confirmation），但没有正在流式输出的
 * - 'generating'：至少一个 session 状态为 running（流式输出中）
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
  return paneStateIndex(state.sessions, nodeId).get(paneKey(deviceId, paneId)) ?? 'none';
}
