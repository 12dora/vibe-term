// 持久化 AI SDK ModelMessage → 对话流 UI 块的纯解析层。
// 持久化格式见 gateway run.ts：assistant content 为 string 或 parts(text/reasoning/tool-call)，
// tool content 为 parts(tool-result/tool-approval-response)，tool-result 按 toolCallId 配对。

import type { AgentMessageDto } from '@tmex/shared';

export interface UiToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  isError: boolean;
  denied: boolean;
  resolved: boolean;
}

export type UiThreadBlock =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant-text'; key: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; key: string; text: string; streaming: boolean }
  | { kind: 'tool-call'; key: string; call: UiToolCall };

export interface UnwrappedToolOutput {
  value: unknown;
  isError: boolean;
  denied: boolean;
}

export interface ParsedPersistedMessages {
  blocks: UiThreadBlock[];
  toolBlocksById: Map<string, UiToolCall>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ModelMessage ToolResultPart 的 output 可能是 SDK ToolResultOutput 包装形态
 * ({type:'text'|'json'|'error-text'|'error-json', value} 或
 * {type:'execution-denied', reason?})，WS 事件里则是 execute 返回值原样；统一解包。
 */
export function unwrapToolOutput(output: unknown): UnwrappedToolOutput {
  if (isRecord(output) && typeof output.type === 'string') {
    switch (output.type) {
      case 'text':
      case 'json':
        if ('value' in output) {
          return { value: output.value, isError: false, denied: false };
        }
        break;
      case 'error-text':
      case 'error-json':
        if ('value' in output) {
          return { value: output.value, isError: true, denied: false };
        }
        break;
      case 'execution-denied':
        return {
          value: typeof output.reason === 'string' ? output.reason : undefined,
          isError: false,
          denied: true,
        };
      default:
        break;
    }
  }
  return { value: output, isError: false, denied: false };
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function parseUserMessage(seq: number, content: unknown): UiThreadBlock | null {
  const text = extractText(content);
  if (!text) return null;
  return { kind: 'user', key: `m${seq}`, text };
}

function toUiToolCall(part: Record<string, unknown>, toolCallId: string): UiToolCall {
  return {
    toolCallId,
    toolName: typeof part.toolName === 'string' ? part.toolName : 'unknown',
    input: part.input,
    isError: false,
    denied: false,
    resolved: false,
  };
}

function parseAssistantPart(key: string, part: unknown): UiThreadBlock | null {
  if (!isRecord(part)) return null;
  const text = typeof part.text === 'string' ? part.text : '';
  if (part.type === 'text' && text) {
    return { kind: 'assistant-text', key, text, streaming: false };
  }
  if (part.type === 'reasoning' && text) {
    return { kind: 'reasoning', key, text, streaming: false };
  }
  if (part.type === 'tool-call' && typeof part.toolCallId === 'string' && part.toolCallId) {
    return { kind: 'tool-call', key, call: toUiToolCall(part, part.toolCallId) };
  }
  return null;
}

export function parseAssistantParts(seq: number, content: unknown): UiThreadBlock[] {
  if (typeof content === 'string') {
    if (!content) return [];
    return [{ kind: 'assistant-text', key: `m${seq}`, text: content, streaming: false }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: UiThreadBlock[] = [];
  content.forEach((part, index) => {
    const block = parseAssistantPart(`m${seq}p${index}`, part);
    if (block) blocks.push(block);
  });
  return blocks;
}

/** 把一个 tool-result part 配对回同 toolCallId 的 tool-call；未配对返回 false。 */
export function applyToolResult(part: unknown, calls: Map<string, UiToolCall>): boolean {
  if (!isRecord(part) || part.type !== 'tool-result') return false;
  if (typeof part.toolCallId !== 'string') return false;
  const existing = calls.get(part.toolCallId);
  if (!existing) return false;
  const { value, isError, denied } = unwrapToolOutput(part.output);
  existing.output = value;
  existing.isError = isError;
  existing.denied = denied;
  existing.resolved = true;
  return true;
}

export function parsePersistedMessages(messages: AgentMessageDto[]): ParsedPersistedMessages {
  const blocks: UiThreadBlock[] = [];
  const toolBlocksById = new Map<string, UiToolCall>();

  for (const message of messages) {
    if (!isRecord(message.content)) continue;
    const content = message.content.content;

    if (message.role === 'user') {
      const block = parseUserMessage(message.seq, content);
      if (block) blocks.push(block);
      continue;
    }
    if (message.role === 'assistant') {
      for (const block of parseAssistantParts(message.seq, content)) {
        if (block.kind === 'tool-call') toolBlocksById.set(block.call.toolCallId, block.call);
        blocks.push(block);
      }
      continue;
    }
    if (message.role === 'tool' && Array.isArray(content)) {
      for (const part of content) applyToolResult(part, toolBlocksById);
    }
  }

  return { blocks, toolBlocksById };
}
