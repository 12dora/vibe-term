import { describe, expect, test } from 'bun:test';
import type { AgentStreamPart, StreamPartHandlers } from './stream-part-router';
import { consumeAgentStream, dispatchStreamPart } from './stream-part-router';

function recordHandlers() {
  const hits: string[] = [];
  const handlers: StreamPartHandlers = {
    'text-delta': (part) => {
      hits.push(`text-delta:${part.id}:${part.text}`);
    },
    'reasoning-delta': (part) => {
      hits.push(`reasoning-delta:${part.id}:${part.text}`);
    },
    'tool-call': (part) => {
      hits.push(`tool-call:${part.toolCallId}:${part.toolName}`);
    },
    'tool-result': (part) => {
      hits.push(`tool-result:${part.toolCallId}:${part.toolName}`);
    },
    'tool-error': (part) => {
      hits.push(`tool-error:${part.toolCallId}:${String(part.error)}`);
    },
    'tool-output-denied': (part) => {
      hits.push(`tool-output-denied:${part.toolCallId}:${part.toolName}`);
    },
    'tool-approval-request': (part) => {
      hits.push(`tool-approval-request:${part.approvalId}:${part.toolCall.toolCallId}`);
    },
    error: (part) => {
      hits.push(`error:${String(part.error)}`);
    },
    abort: () => {
      hits.push('abort');
    },
  };
  return { hits, handlers };
}

describe('dispatchStreamPart', () => {
  test('按 type 分发到对应 handler', () => {
    const { hits, handlers } = recordHandlers();
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
        error: 'boom',
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
      dispatchStreamPart(part, handlers);
    }
    expect(hits).toEqual([
      'text-delta:t1:hi',
      'reasoning-delta:r1:think',
      'tool-call:c1:read_screen',
      'tool-result:c1:read_screen',
      'tool-error:c2:boom',
      'tool-output-denied:c3:send_input',
      'tool-approval-request:a1:c4',
      'error:upstream',
      'abort',
    ]);
  });

  test('未知 type 静默忽略', () => {
    const { hits, handlers } = recordHandlers();
    dispatchStreamPart({ type: 'start' }, handlers);
    dispatchStreamPart({ type: 'text-start', id: 't0' }, handlers);
    expect(hits).toEqual([]);
  });
});

describe('consumeAgentStream', () => {
  test('start → 每个 part reset → finally clear；未知 type 忽略', async () => {
    const { hits, handlers } = recordHandlers();
    const events: string[] = [];
    const stream = (async function* () {
      yield { type: 'text-delta', id: 't1', text: 'hi' } satisfies AgentStreamPart;
      yield { type: 'start' } satisfies AgentStreamPart;
      yield { type: 'abort' } satisfies AgentStreamPart;
    })();

    await consumeAgentStream(stream, handlers, {
      start: () => events.push('start'),
      reset: () => events.push('reset'),
      clear: () => events.push('clear'),
    });
    expect(events).toEqual(['start', 'reset', 'reset', 'reset', 'clear']);
    expect(hits).toEqual(['text-delta:t1:hi', 'abort']);
  });

  test('stream 抛错仍 clear watchdog', async () => {
    const { handlers } = recordHandlers();
    const events: string[] = [];
    const stream = (async function* () {
      yield { type: 'text-delta', id: 't1', text: 'x' } satisfies AgentStreamPart;
      throw new Error('broken');
    })();
    await expect(
      consumeAgentStream(stream, handlers, {
        start: () => events.push('start'),
        reset: () => events.push('reset'),
        clear: () => events.push('clear'),
      })
    ).rejects.toThrow('broken');
    expect(events).toEqual(['start', 'reset', 'clear']);
  });
});
