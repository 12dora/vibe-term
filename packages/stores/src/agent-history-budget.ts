// 非活跃会话历史的保留预算：只留最近激活的若干份，超预算的历史清空，重新打开时全量重拉。

import type { AgentMessageDto } from '@tmex/shared';
import type { AgentStateData } from './agent-state';

/** 保留的非活跃历史份数上限 */
export const HISTORY_SESSION_BUDGET = 8;
/** 保留的非活跃历史体积上限（消息 content 序列化后的字符数） */
export const HISTORY_SIZE_BUDGET = 4 * 1024 * 1024;

// 体积按数组引用缓存：合并消息会换新数组，未变的会话不重复序列化
const historySizes = new WeakMap<AgentMessageDto[], number>();

function historySize(messages: AgentMessageDto[]): number {
  const cached = historySizes.get(messages);
  if (cached !== undefined) return cached;
  let size = 0;
  for (const message of messages) {
    size += JSON.stringify(message.content).length;
  }
  historySizes.set(messages, size);
  return size;
}

/** 运行中、有流式段、有排队消息或待确认的会话不参与淘汰 */
function isBusy(state: AgentStateData, sessionId: string): boolean {
  const status = state.sessions[sessionId]?.status;
  const inProgress = state.inProgress[sessionId];
  return (
    status === 'running' ||
    status === 'waiting_confirmation' ||
    (inProgress?.texts.length ?? 0) > 0 ||
    (inProgress?.reasonings.length ?? 0) > 0 ||
    (inProgress?.toolCalls.length ?? 0) > 0 ||
    (state.queued[sessionId]?.length ?? 0) > 0 ||
    (state.pendingConfirmations[sessionId]?.length ?? 0) > 0
  );
}

function recentRank(recent: readonly string[], sessionId: string): number {
  const index = recent.indexOf(sessionId);
  return index === -1 ? recent.length : index;
}

/**
 * 选出应清空历史的会话：各 node 的当前会话与忙碌会话固定保留，
 * 其余按 `recent`（最近激活在前）保留到份数或体积预算用尽为止。
 */
export function selectEvictableHistories(
  state: AgentStateData,
  recent: readonly string[]
): string[] {
  const active = new Set<string | null>(Object.values(state.activeSessionIdByNode));
  const candidates = Object.entries(state.messages).filter(
    (entry): entry is [string, AgentMessageDto[]] =>
      entry[1] !== undefined && !active.has(entry[0]) && !isBusy(state, entry[0])
  );
  candidates.sort(([a], [b]) => recentRank(recent, a) - recentRank(recent, b));

  const evicted: string[] = [];
  let size = 0;
  for (const [index, [id, messages]] of candidates.entries()) {
    // 一旦开始淘汰，更久未激活的一律淘汰，不必再量体积
    if (evicted.length === 0 && index < HISTORY_SESSION_BUDGET) {
      size += historySize(messages);
      if (size <= HISTORY_SIZE_BUDGET) continue;
    }
    evicted.push(id);
  }
  return evicted;
}
