import { describe, expect, test } from 'bun:test';

import type { AgentMessageDto } from '@tmex/shared';
import { type SessionInProgress, buildThreadBlocks, unwrapToolOutput } from './agent-thread';

describe('unwrapToolOutput', () => {
  test('unwraps text/json as success', () => {
    expect(unwrapToolOutput({ type: 'text', value: 'ok' })).toEqual({
      value: 'ok',
      isError: false,
      denied: false,
    });
    expect(unwrapToolOutput({ type: 'json', value: { a: 1 } })).toEqual({
      value: { a: 1 },
      isError: false,
      denied: false,
    });
  });

  test('unwraps error-text/error-json as error', () => {
    expect(unwrapToolOutput({ type: 'error-text', value: 'boom' })).toEqual({
      value: 'boom',
      isError: true,
      denied: false,
    });
    expect(unwrapToolOutput({ type: 'error-json', value: { message: 'boom' } })).toEqual({
      value: { message: 'boom' },
      isError: true,
      denied: false,
    });
  });

  test('unwraps execution-denied (no value field) as denied with reason', () => {
    expect(unwrapToolOutput({ type: 'execution-denied', reason: 'user denied' })).toEqual({
      value: 'user denied',
      isError: false,
      denied: true,
    });
    expect(unwrapToolOutput({ type: 'execution-denied' })).toEqual({
      value: undefined,
      isError: false,
      denied: true,
    });
  });

  test('passes through raw execute return values', () => {
    expect(unwrapToolOutput('plain string')).toEqual({
      value: 'plain string',
      isError: false,
      denied: false,
    });
    const raw = { screen: 'foo', type: 42 };
    expect(unwrapToolOutput(raw)).toEqual({ value: raw, isError: false, denied: false });
  });
});

describe('buildThreadBlocks denied tool result pairing', () => {
  function makeMessages(): AgentMessageDto[] {
    return [
      {
        id: 'm1',
        sessionId: 's1',
        seq: 0,
        role: 'assistant',
        content: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'x' } },
          ],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        sessionId: 's1',
        seq: 1,
        role: 'tool',
        content: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tc-1',
              toolName: 'send_input',
              output: { type: 'execution-denied', reason: 'not allowed' },
            },
          ],
        },
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ] as AgentMessageDto[];
  }

  test('marks paired tool call as denied instead of success', () => {
    const blocks = buildThreadBlocks(makeMessages(), undefined);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block.kind !== 'tool-call') {
      throw new Error('expected tool-call block');
    }
    expect(block.call.resolved).toBe(true);
    expect(block.call.denied).toBe(true);
    expect(block.call.isError).toBe(false);
    expect(block.call.output).toBe('not allowed');
  });

  test('error-json result marks tool call as error', () => {
    const messages = makeMessages();
    const toolMessage = messages[1].content as {
      content: Array<{ output: unknown }>;
    };
    toolMessage.content[0].output = { type: 'error-json', value: { error: 'failed' } };
    const blocks = buildThreadBlocks(messages, undefined);
    const block = blocks[0];
    if (block.kind !== 'tool-call') {
      throw new Error('expected tool-call block');
    }
    expect(block.call.resolved).toBe(true);
    expect(block.call.denied).toBe(false);
    expect(block.call.isError).toBe(true);
  });
});

describe('buildThreadBlocks caching', () => {
  function history(count: number): AgentMessageDto[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      sessionId: 's1',
      seq: i,
      role: 'user',
      content: { role: 'user', content: `hello ${i}` },
      createdAt: '2026-01-01T00:00:00.000Z',
    })) as AgentMessageDto[];
  }

  function progress(text: string): SessionInProgress {
    return {
      texts: [{ messageId: 'x', text, stale: false }],
      reasonings: [],
      toolCalls: [],
      staleBarrier: false,
    };
  }

  test('reuses parsed history across calls with the same messages array', () => {
    const messages = history(3);
    const first = buildThreadBlocks(messages, undefined);
    const second = buildThreadBlocks(messages, undefined);
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  test('historical block identities stay stable while the live tail changes', () => {
    const messages = history(3);
    const first = buildThreadBlocks(messages, progress('a'));
    const second = buildThreadBlocks(messages, progress('ab'));
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    expect(second[3]).not.toBe(first[3]);
    expect(second[3]).toMatchObject({ kind: 'assistant-text', text: 'ab', streaming: true });
  });

  test('unchanged live segments keep their block identity', () => {
    const messages = history(1);
    const inProgress = progress('a');
    const first = buildThreadBlocks(messages, inProgress);
    const second = buildThreadBlocks(messages, { ...inProgress, staleBarrier: true });
    expect(second[1]).toBe(first[1]);
  });

  test('live tool result patches only the affected block and never mutates the parsed history', () => {
    const pending = [
      {
        id: 'm1',
        sessionId: 's1',
        seq: 0,
        role: 'assistant',
        content: {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'x' } },
          ],
        },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ] as AgentMessageDto[];
    const call = {
      toolCallId: 'tc-1',
      toolName: 'send_input',
      input: { text: 'x' },
      output: 'done',
      isError: false,
      denied: false,
      resolved: true,
      stale: false,
    };
    const live: SessionInProgress = {
      texts: [],
      reasonings: [],
      toolCalls: [call],
      staleBarrier: false,
    };

    const before = buildThreadBlocks(pending, undefined);
    const after = buildThreadBlocks(pending, live);
    if (before[0].kind !== 'tool-call' || after[0].kind !== 'tool-call') {
      throw new Error('expected tool-call blocks');
    }
    expect(after[0]).not.toBe(before[0]);
    expect(before[0].call.resolved).toBe(false);
    expect(after[0].call.resolved).toBe(true);
    expect(after[0].call.output).toBe('done');
    // 再次 flush 命中已打补丁的缓存，不产生新对象
    expect(buildThreadBlocks(pending, live)).toBe(after);
  });
});
