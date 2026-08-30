import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { ModelMessage } from 'ai';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { applyMessageWindow } from '../agent/build-run-request';
import {
  appendAgentMessage,
  createAgentSession,
  getFirstAgentUserMessage,
  listAgentMessages,
  listAgentMessagesForWindow,
} from './agent';
import { getDb as getOrmDb } from './client';

beforeAll(() => {
  migrate(getOrmDb(), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
});

function toMessages(records: Array<{ content: unknown }>): ModelMessage[] {
  return records.map((record) => record.content as ModelMessage);
}

function windowedEqualsFull(sessionId: string, budget: number, pageSize = 3): void {
  const fullRows = listAgentMessages(sessionId);
  const windowRows = listAgentMessagesForWindow(sessionId, budget, { pageSize, lengthMargin: 32 });
  expect(applyMessageWindow(toMessages(windowRows), budget)).toEqual(
    applyMessageWindow(toMessages(fullRows), budget)
  );
}

describe('listAgentMessagesForWindow', () => {
  test('短历史：与全量加载滑窗结果相同，且加载全部行', () => {
    const session = createAgentSession({ title: 'short', modelId: 'm' });
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'hi' });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    });
    const full = listAgentMessages(session.id);
    const windowed = listAgentMessagesForWindow(session.id, 10_000, { pageSize: 2 });
    expect(windowed.map((row) => row.id)).toEqual(full.map((row) => row.id));
    windowedEqualsFull(session.id, 10_000, 2);
  });

  test('超预算：与全量加载滑窗结果相同，且少加载前缀行', () => {
    const session = createAgentSession({ title: 'over-budget', modelId: 'm' });
    for (let i = 0; i < 6; i++) {
      appendAgentMessage(session.id, 'user', {
        role: 'user',
        content: `old-${i}:${'x'.repeat(600)}`,
      });
      appendAgentMessage(session.id, 'assistant', {
        role: 'assistant',
        content: [{ type: 'text', text: `old-a-${i}` }],
      });
    }
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'second' });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'new' }],
    });
    const budget = 400;
    const full = listAgentMessages(session.id);
    const windowed = listAgentMessagesForWindow(session.id, budget, {
      pageSize: 2,
      lengthMargin: 32,
    });
    expect(windowed.length).toBeLessThan(full.length);
    expect(windowed[0]?.seq).toBeGreaterThan(full[0]?.seq ?? -1);
    windowedEqualsFull(session.id, budget, 2);
    const kept = applyMessageWindow(toMessages(windowed), budget);
    expect(kept[0]).toEqual({ role: 'user', content: 'second' });
    expect(kept).toEqual(toMessages(full).slice(-2));
  });

  test('截断点落在 tool-call/tool-result 对内时，滑窗仍与全量一致且不拆对', () => {
    const session = createAgentSession({ title: 'tool-boundary', modelId: 'm' });
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'x'.repeat(600) });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'call_a', toolName: 'read_screen', input: {} }],
    });
    appendAgentMessage(session.id, 'tool', {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_a',
          toolName: 'read_screen',
          output: { type: 'text', value: 'y'.repeat(600) },
        },
      ],
    });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'step one done' }],
    });
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'second question' });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'second answer' }],
    });
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'third question' });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'third answer' }],
    });

    const budget = 400;
    const full = listAgentMessages(session.id);
    const windowed = listAgentMessagesForWindow(session.id, budget, {
      pageSize: 3,
      lengthMargin: 32,
    });
    expect(windowed.length).toBeLessThan(full.length);
    windowedEqualsFull(session.id, budget, 3);

    const kept = applyMessageWindow(toMessages(windowed), budget);
    expect(kept).toEqual(toMessages(full).slice(4));
    const toolCallIds = new Set(
      kept
        .filter((message) => message.role === 'assistant' && Array.isArray(message.content))
        .flatMap((message) => message.content as Array<{ type: string; toolCallId?: string }>)
        .filter((part) => part.type === 'tool-call')
        .map((part) => part.toolCallId)
    );
    for (const message of kept) {
      if (message.role !== 'tool') continue;
      for (const part of message.content as Array<{ type: string; toolCallId?: string }>) {
        if (part.type === 'tool-result') {
          expect(toolCallIds.has(part.toolCallId)).toBe(true);
        }
      }
    }
  });
});

describe('getFirstAgentUserMessage', () => {
  test('返回 seq 最早的 user，忽略更早的 assistant', () => {
    const session = createAgentSession({ title: 'first-user', modelId: 'm' });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'ignore' }],
    });
    const first = appendAgentMessage(session.id, 'user', { role: 'user', content: 'alpha' });
    appendAgentMessage(session.id, 'user', { role: 'user', content: 'omega' });
    expect(getFirstAgentUserMessage(session.id)?.id).toBe(first.id);
    expect(getFirstAgentUserMessage(session.id)?.content).toEqual({
      role: 'user',
      content: 'alpha',
    });
  });

  test('没有 user 时返回 null', () => {
    const session = createAgentSession({ title: 'no-user', modelId: 'm' });
    appendAgentMessage(session.id, 'assistant', {
      role: 'assistant',
      content: [{ type: 'text', text: 'only' }],
    });
    expect(getFirstAgentUserMessage(session.id)).toBeNull();
  });
});
