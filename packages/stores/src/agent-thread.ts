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

const EMPTY_MESSAGES: AgentMessageDto[] = [];

interface HistoryCache {
  /** 纯历史解析结果，标识稳定 */
  base: UiThreadBlock[];
  /** base 叠加流式 tool-result 后的版本（copy-on-write），无补丁时即 base */
  patched: UiThreadBlock[];
  /** toolCallId -> 在数组中的下标 */
  toolIndex: Map<string, number>;
}

// 按 messages 数组引用缓存历史解析：每次 delta flush 只重建流式尾部，不再全量重解析。
const historyCache = new WeakMap<AgentMessageDto[], HistoryCache>();
// 流式块按 inProgress 段/调用对象引用缓存，未变化的段保持块标识稳定（供 React.memo 命中）。
const liveBlockCache = new WeakMap<object, UiThreadBlock>();

function historyOf(messages: AgentMessageDto[]): HistoryCache {
  const cached = historyCache.get(messages);
  if (cached) return cached;
  const { blocks } = parsePersistedMessages(messages);
  const toolIndex = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block.kind === 'tool-call') toolIndex.set(block.call.toolCallId, index);
  });
  const entry: HistoryCache = { base: blocks, patched: blocks, toolIndex };
  historyCache.set(messages, entry);
  return entry;
}

/** 把流式里已出结果的 tool-call 补进历史块：只替换受影响的那一个块，其余保持原对象。 */
function patchResolved(entry: HistoryCache, calls: InProgressToolCall[]): void {
  let next: UiThreadBlock[] | null = null;
  for (const call of calls) {
    if (!call.resolved) continue;
    const index = entry.toolIndex.get(call.toolCallId);
    if (index === undefined) continue;
    const block = (next ?? entry.patched)[index];
    if (block.kind !== 'tool-call' || block.call.resolved) continue;
    next ??= [...entry.patched];
    next[index] = {
      ...block,
      call: {
        ...block.call,
        output: call.output,
        isError: call.isError,
        denied: call.denied,
        resolved: true,
      },
    };
  }
  if (next) entry.patched = next;
}

function cachedBlock(source: object, create: () => UiThreadBlock): UiThreadBlock {
  const cached = liveBlockCache.get(source);
  if (cached) return cached;
  const block = create();
  liveBlockCache.set(source, block);
  return block;
}

function liveTail(entry: HistoryCache, inProgress: SessionInProgress): UiThreadBlock[] {
  const tail: UiThreadBlock[] = [];
  for (const call of inProgress.toolCalls) {
    if (entry.toolIndex.has(call.toolCallId)) continue;
    tail.push(
      cachedBlock(call, () => ({ kind: 'tool-call', key: `live-tool-${call.toolCallId}`, call }))
    );
  }
  for (const segment of inProgress.reasonings) {
    if (!segment.text) continue;
    tail.push(
      cachedBlock(segment, () => ({
        kind: 'reasoning',
        key: `live-reasoning-${segment.messageId}`,
        text: segment.text,
        streaming: true,
      }))
    );
  }
  for (const segment of inProgress.texts) {
    if (!segment.text) continue;
    tail.push(
      cachedBlock(segment, () => ({
        kind: 'assistant-text',
        key: `live-text-${segment.messageId}`,
        text: segment.text,
        streaming: true,
      }))
    );
  }
  return tail;
}

/**
 * 合并持久化消息与流式中状态：
 * - 历史中未配对的 tool-call 用 inProgress 里同 toolCallId 的即时结果补全；
 * - inProgress 独有的 toolCalls / 文本段追加在末尾（流式显示）。
 * 历史部分按 messages 引用缓存，跨 flush 保持块对象标识不变。
 */
export function buildThreadBlocks(
  messages: AgentMessageDto[] | undefined,
  inProgress: SessionInProgress | undefined
): UiThreadBlock[] {
  const entry = historyOf(messages ?? EMPTY_MESSAGES);
  if (!inProgress) {
    return entry.base;
  }
  patchResolved(entry, inProgress.toolCalls);
  const tail = liveTail(entry, inProgress);
  return tail.length === 0 ? entry.patched : [...entry.patched, ...tail];
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
