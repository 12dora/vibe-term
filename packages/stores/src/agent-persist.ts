// agent store 持久化分片的版本与迁移。

import { SELF_NODE_ID } from '@tmex/api-client';
import type { AgentState } from './agent-state';

/** v1：单值 `activeSessionId` 拆成按 node 分片的 `activeSessionIdByNode`。 */
export const AGENT_PERSIST_VERSION = 1;

interface LegacyPersistedAgentState {
  activeSessionId?: string | null;
}

/**
 * v0 的持久化状态只可能来自单 node 时期，选中的会话一定属于 entry 自身，
 * 因此整体迁到 `self` 分片；再旧/损坏的形状按空分片处理（最坏就是少恢复一次选中）。
 */
export function migrateAgentPersistedState(persisted: unknown, version: number): AgentState {
  const state = (persisted ?? {}) as Partial<AgentState>;
  if (version >= AGENT_PERSIST_VERSION) return state as AgentState;
  const legacyId = (persisted as LegacyPersistedAgentState | null)?.activeSessionId ?? null;
  return {
    ...state,
    activeSessionIdByNode: legacyId ? { [SELF_NODE_ID]: legacyId } : {},
  } as AgentState;
}
