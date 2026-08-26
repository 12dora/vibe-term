import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { createRunStreamHandlers } from './run-stream-handlers';
import type { AgentStreamPart } from './stream-part-router';

function broadcastLabel(eventType: number): string {
  if (eventType === wsBorsh.AGENT_EVENT_TOOL_CALL) return 'broadcast:tool-call';
  if (eventType === wsBorsh.AGENT_EVENT_TOOL_RESULT) return 'broadcast:tool-result';
  return `broadcast:${eventType}`;
}

describe('createRunStreamHandlers', () => {
  test('按 part 类型 flush/queue/broadcast/approval/error/abort', () => {
    const timeline: string[] = [];
    const broadcasts: Array<{ eventType: number; payload: unknown }> = [];
    const approvals: Array<{
      approvalId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }> = [];
    approvals.push = ((item: (typeof approvals)[number]) => {
      timeline.push('approval');
      return Array.prototype.push.call(approvals, item);
    }) as typeof approvals.push;
    const errors: unknown[] = [];
    let aborted = 0;

    const handlers = createRunStreamHandlers({
      deltas: {
        queueTextDelta: (id, text) => {
          timeline.push(`text:${id}:${text}`);
        },
        queueReasoningDelta: (id, text) => {
          timeline.push(`reason:${id}:${text}`);
        },
        flush: () => {
          timeline.push('flush');
        },
      },
      broadcast: (eventType, payload) => {
        timeline.push(broadcastLabel(eventType));
        broadcasts.push({ eventType, payload });
      },
      approvals,
      onError: (error) => {
        timeline.push('error');
        errors.push(error);
      },
      onAbort: () => {
        timeline.push('abort');
        aborted += 1;
      },
    });

    const parts: AgentStreamPart[] = [
      { type: 'text-delta', id: 't1', text: 'hi' },
      { type: 'reasoning-delta', id: 'r1', text: 'think' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'read_screen',
        input: {},
        dynamic: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read_screen',
        input: {},
        output: { ok: true },
        dynamic: true,
      },
      {
        type: 'tool-error',
        toolCallId: 'c2',
        toolName: 'send_input',
        input: {},
        error: new Error('boom'),
        dynamic: true,
      },
      { type: 'tool-output-denied', toolCallId: 'c3', toolName: 'send_input' },
      {
        type: 'tool-approval-request',
        approvalId: 'a1',
        toolCall: {
          type: 'tool-call',
          toolCallId: 'c4',
          toolName: 'send_input',
          input: { text: 'ls' },
          dynamic: true,
        },
      },
      { type: 'error', error: 'upstream' },
      { type: 'abort' },
    ];

    for (const part of parts) {
      const handler = handlers[part.type as keyof typeof handlers] as
        | ((p: AgentStreamPart) => void)
        | undefined;
      handler?.(part);
    }

    expect(timeline).toEqual([
      'text:t1:hi',
      'reason:r1:think',
      'flush',
      'broadcast:tool-call',
      'flush',
      'broadcast:tool-result',
      'flush',
      'broadcast:tool-result',
      'flush',
      'broadcast:tool-result',
      'approval',
      'error',
      'abort',
    ]);
    expect(broadcasts).toEqual([
      {
        eventType: wsBorsh.AGENT_EVENT_TOOL_CALL,
        payload: { toolCallId: 'c1', toolName: 'read_screen', input: {} },
      },
      {
        eventType: wsBorsh.AGENT_EVENT_TOOL_RESULT,
        payload: { toolCallId: 'c1', toolName: 'read_screen', output: { ok: true } },
      },
      {
        eventType: wsBorsh.AGENT_EVENT_TOOL_RESULT,
        payload: { toolCallId: 'c2', toolName: 'send_input', output: 'boom', isError: true },
      },
      {
        eventType: wsBorsh.AGENT_EVENT_TOOL_RESULT,
        payload: {
          toolCallId: 'c3',
          toolName: 'send_input',
          output: 'execution denied by user',
          isError: true,
        },
      },
    ]);
    expect(approvals).toEqual([
      { approvalId: 'a1', toolCallId: 'c4', toolName: 'send_input', input: { text: 'ls' } },
    ]);
    expect(errors).toEqual(['upstream']);
    expect(aborted).toBe(1);
  });
});
