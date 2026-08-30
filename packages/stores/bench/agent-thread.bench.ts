// 用法: bun run packages/stores/bench/agent-thread.bench.ts
// 对比对话流块拼装的两种实现：每次 flush 全量重解析历史 vs 按 messages 引用缓存 + 流式尾部叠加。

import type { AgentMessageDto } from '@tmex/shared';
import { parsePersistedMessages } from '../src/agent-message-parser';
import type { UiThreadBlock } from '../src/agent-message-parser';
import { type SessionInProgress, buildThreadBlocks } from '../src/agent-thread';

const MESSAGE_COUNT = 2000;
const FLUSHES = 500;

/** 改造前的实现：每次调用重新解析全部历史消息 */
function buildThreadBlocksLegacy(
  messages: AgentMessageDto[],
  inProgress: SessionInProgress
): UiThreadBlock[] {
  const { blocks, toolBlocksById } = parsePersistedMessages(messages);
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
    blocks.push({ kind: 'tool-call', key: `live-tool-${call.toolCallId}`, call });
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

function makeMessages(count: number): AgentMessageDto[] {
  return Array.from({ length: count }, (_, i) => {
    const assistant = i % 2 === 1;
    return {
      id: `m${i}`,
      sessionId: 's1',
      seq: i,
      role: assistant ? 'assistant' : 'user',
      content: assistant
        ? {
            role: 'assistant',
            content: [
              { type: 'text', text: `answer ${i}` },
              {
                type: 'tool-call',
                toolCallId: `tc-${i}`,
                toolName: 'send_input',
                input: { text: `x${i}` },
              },
            ],
          }
        : { role: 'user', content: `question ${i}` },
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }) as AgentMessageDto[];
}

function run(
  label: string,
  messages: AgentMessageDto[],
  build: (messages: AgentMessageDto[], inProgress: SessionInProgress) => UiThreadBlock[]
): void {
  let text = '';
  let blocks = 0;
  const started = performance.now();
  for (let i = 0; i < FLUSHES; i++) {
    text += 'token ';
    const inProgress: SessionInProgress = {
      texts: [{ messageId: 'live', text, stale: false }],
      reasonings: [],
      toolCalls: [],
      staleBarrier: false,
    };
    blocks = build(messages, inProgress).length;
  }
  const ms = performance.now() - started;
  console.log(
    `${label}: ${ms.toFixed(1)}ms total, ${(ms / FLUSHES).toFixed(3)}ms/flush (${blocks} blocks)`
  );
}

const messages = makeMessages(MESSAGE_COUNT);
run('legacy (reparse every flush)', messages, buildThreadBlocksLegacy);
run('cached (WeakMap by messages ref)', messages, buildThreadBlocks);
