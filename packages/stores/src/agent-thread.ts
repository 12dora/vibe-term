// 将持久化的 AI SDK ModelMessage 序列与流式中的 inProgress 状态合并为对话流 UI 块。
// 解析持久化消息的纯逻辑在 agent-message-parser.ts。

import type { AgentMessageDto } from '@tmex/shared';
import { extractText, isRecord, parsePersistedMessages } from './agent-message-parser';
import type { UiThreadBlock, UiToolCall } from './agent-message-parser';

export type {
  ParsedPersistedMessages,
  UiThreadBlock,
  UiToolCall,
  UnwrappedToolOutput,
} from './agent-message-parser';
export {
  applyToolResult,
  parseAssistantParts,
  parsePersistedMessages,
  parseUserMessage,
  unwrapToolOutput,
} from './agent-message-parser';

export interface InProgressSegment {
  messageId: string;
  text: string;
  stale: boolean;
}

export interface InProgressToolCall extends UiToolCall {
  stale: boolean;
}

export interface SessionInProgress {
  texts: InProgressSegment[];
  reasonings: InProgressSegment[];
  toolCalls: InProgressToolCall[];
  // MESSAGE_PERSISTED 后置位：此后新建的流式段也视为已落库内容的残余，
  // 等历史增量拉取落地时一并清除，避免与历史消息重复显示
  staleBarrier: boolean;
}

export function emptyInProgress(): SessionInProgress {
  return { texts: [], reasonings: [], toolCalls: [], staleBarrier: false };
}

/**
 * 合并持久化消息与流式中状态：
 * - 历史中未配对的 tool-call 用 inProgress 里同 toolCallId 的即时结果补全；
 * - inProgress 独有的 toolCalls / 文本段追加在末尾（流式显示）。
 */
export function buildThreadBlocks(
  messages: AgentMessageDto[] | undefined,
  inProgress: SessionInProgress | undefined
): UiThreadBlock[] {
  const { blocks, toolBlocksById } = parsePersistedMessages(messages ?? []);

  if (!inProgress) {
    return blocks;
  }

  for (const call of inProgress.toolCalls) {
    const existing = toolBlocksById.get(call.toolCallId);
    if (existing) {
      if (!existing.resolved && call.resolved) {
        existing.output = call.output;
        existing.isError = call.isError;
        existing.denied = call.denied;
        existing.resolved = true;
      }
      continue;
    }
    blocks.push({
      kind: 'tool-call',
      key: `live-tool-${call.toolCallId}`,
      call,
    });
  }

  for (const segment of inProgress.reasonings) {
    if (!segment.text) continue;
    blocks.push({
      kind: 'reasoning',
      key: `live-reasoning-${segment.messageId}`,
      text: segment.text,
      streaming: true,
    });
  }

  for (const segment of inProgress.texts) {
    if (!segment.text) continue;
    blocks.push({
      kind: 'assistant-text',
      key: `live-text-${segment.messageId}`,
      text: segment.text,
      streaming: true,
    });
  }

  return blocks;
}

export function maxMessageSeq(messages: AgentMessageDto[] | undefined): number {
  if (!messages || messages.length === 0) {
    return -1;
  }
  return messages[messages.length - 1].seq;
}

/** 找最后一条 user 消息文本（error 重试用） */
export function lastUserMessageText(messages: AgentMessageDto[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const model = isRecord(message.content) ? message.content : null;
    const text = model ? extractText(model.content) : '';
    if (text) return text;
  }
  return null;
}
