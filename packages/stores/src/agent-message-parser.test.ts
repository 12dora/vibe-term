import { describe, expect, test } from 'bun:test';

import type { AgentMessageDto } from '@tmex/shared';
import {
  type UiThreadBlock,
  type UiToolCall,
  applyToolResult,
  parseAssistantParts,
  parsePersistedMessages,
  parseUserMessage,
} from './agent-message-parser';

function message(seq: number, role: string, content: unknown): AgentMessageDto {
  return {
    id: `m${seq}`,
    sessionId: 's1',
    seq,
    role,
    content: { role, content },
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as AgentMessageDto;
}

function summarize(block: UiThreadBlock): string {
  if (block.kind === 'tool-call') {
    return `tool-call:${block.key}:${block.call.toolName}:${block.call.toolCallId}`;
  }
  return `${block.kind}:${block.key}:${block.text}`;
}

function makeCall(toolCallId: string): UiToolCall {
  return {
    toolCallId,
    toolName: 'send_input',
    input: { text: 'x' },
    isError: false,
    denied: false,
    resolved: false,
  };
}

describe('parseUserMessage', () => {
  const cases: Array<{ name: string; content: unknown; expected: string | null }> = [
    { name: 'string content', content: 'hello', expected: 'user:m3:hello' },
    {
      name: 'text parts joined by newline',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
      expected: 'user:m3:a\nb',
    },
    {
      name: 'malformed parts are dropped',
      content: [null, 42, { type: 'text' }, { type: 'text', text: 'kept' }],
      expected: 'user:m3:kept',
    },
    { name: 'empty string yields no block', content: '', expected: null },
    { name: 'empty parts yield no block', content: [], expected: null },
    { name: 'non-array object yields no block', content: { text: 'nope' }, expected: null },
    { name: 'undefined yields no block', content: undefined, expected: null },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const block = parseUserMessage(3, item.content);
      expect(block ? summarize(block) : null).toBe(item.expected);
    });
  }
});

describe('parseAssistantParts', () => {
  const cases: Array<{ name: string; content: unknown; expected: string[] }> = [
    { name: 'string content', content: 'done', expected: ['assistant-text:m1:done'] },
    { name: 'empty string', content: '', expected: [] },
    { name: 'non-array object', content: { type: 'text', text: 'x' }, expected: [] },
    {
      name: 'text + reasoning + tool-call parts',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'x' } },
      ],
      expected: [
        'assistant-text:m1p0:answer',
        'reasoning:m1p1:thinking',
        'tool-call:m1p2:send_input:tc-1',
      ],
    },
    {
      name: 'empty text/reasoning parts are dropped',
      content: [
        { type: 'text', text: '' },
        { type: 'reasoning', text: '' },
      ],
      expected: [],
    },
    {
      name: 'malformed parts are dropped, indexes preserved',
      content: [
        null,
        'raw',
        { type: 'text', text: 42 },
        { type: 'tool-call', toolName: 'send_input' },
        { type: 'tool-call', toolCallId: '' },
        { type: 'unknown-part', text: 'x' },
        { type: 'text', text: 'kept' },
      ],
      expected: ['assistant-text:m1p6:kept'],
    },
    {
      name: 'tool-call without toolName falls back to unknown',
      content: [{ type: 'tool-call', toolCallId: 'tc-9' }],
      expected: ['tool-call:m1p0:unknown:tc-9'],
    },
  ];

  for (const item of cases) {
    test(item.name, () => {
      expect(parseAssistantParts(1, item.content).map(summarize)).toEqual(item.expected);
    });
  }

  test('tool-call block carries the raw input', () => {
    const blocks = parseAssistantParts(1, [
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'x' } },
    ]);
    const block = blocks[0];
    if (block.kind !== 'tool-call') throw new Error('expected tool-call block');
    expect(block.call).toEqual({
      toolCallId: 'tc-1',
      toolName: 'send_input',
      input: { text: 'x' },
      isError: false,
      denied: false,
      resolved: false,
    });
  });
});

describe('applyToolResult', () => {
  const cases: Array<{
    name: string;
    part: unknown;
    applied: boolean;
    expected?: Partial<UiToolCall>;
  }> = [
    {
      name: 'matching text result resolves the call',
      part: { type: 'tool-result', toolCallId: 'tc-1', output: { type: 'text', value: 'ok' } },
      applied: true,
      expected: { output: 'ok', isError: false, denied: false, resolved: true },
    },
    {
      name: 'matching error-json result marks error',
      part: {
        type: 'tool-result',
        toolCallId: 'tc-1',
        output: { type: 'error-json', value: { error: 'boom' } },
      },
      applied: true,
      expected: { output: { error: 'boom' }, isError: true, denied: false, resolved: true },
    },
    {
      name: 'matching execution-denied result marks denied',
      part: {
        type: 'tool-result',
        toolCallId: 'tc-1',
        output: { type: 'execution-denied', reason: 'not allowed' },
      },
      applied: true,
      expected: { output: 'not allowed', isError: false, denied: true, resolved: true },
    },
    {
      name: 'raw output passes through',
      part: { type: 'tool-result', toolCallId: 'tc-1', output: 'plain' },
      applied: true,
      expected: { output: 'plain', isError: false, denied: false, resolved: true },
    },
    {
      name: 'unmatched toolCallId is ignored',
      part: { type: 'tool-result', toolCallId: 'tc-other', output: { type: 'text', value: 'ok' } },
      applied: false,
    },
    {
      name: 'missing toolCallId is ignored',
      part: { type: 'tool-result', output: { type: 'text', value: 'ok' } },
      applied: false,
    },
    {
      name: 'non tool-result part is ignored',
      part: { type: 'tool-approval-response', toolCallId: 'tc-1', approved: true },
      applied: false,
    },
    { name: 'non-record part is ignored', part: null, applied: false },
  ];

  for (const item of cases) {
    test(item.name, () => {
      const call = makeCall('tc-1');
      const calls = new Map([[call.toolCallId, call]]);

      expect(applyToolResult(item.part, calls)).toBe(item.applied);

      if (item.expected) {
        expect(call).toMatchObject(item.expected);
      } else {
        expect(call.resolved).toBe(false);
        expect(call.output).toBeUndefined();
      }
    });
  }
});

describe('parsePersistedMessages', () => {
  test('user / assistant / tool matrix produces ordered blocks', () => {
    const { blocks, toolBlocksById } = parsePersistedMessages([
      message(0, 'user', 'hi'),
      message(1, 'assistant', [
        { type: 'text', text: 'working' },
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'x' } },
      ]),
      message(2, 'tool', [
        { type: 'tool-result', toolCallId: 'tc-1', output: { type: 'text', value: 'ok' } },
      ]),
      message(3, 'assistant', 'done'),
    ]);

    expect(blocks.map(summarize)).toEqual([
      'user:m0:hi',
      'assistant-text:m1p0:working',
      'tool-call:m1p1:send_input:tc-1',
      'assistant-text:m3:done',
    ]);
    expect(toolBlocksById.get('tc-1')).toMatchObject({ resolved: true, output: 'ok' });
  });

  test('tool result without a matching call leaves the call unresolved', () => {
    const { toolBlocksById } = parsePersistedMessages([
      message(0, 'assistant', [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: {} },
      ]),
      message(1, 'tool', [
        { type: 'tool-result', toolCallId: 'tc-missing', output: { type: 'text', value: 'ok' } },
      ]),
    ]);

    expect(toolBlocksById.get('tc-1')?.resolved).toBe(false);
    expect(toolBlocksById.has('tc-missing')).toBe(false);
  });

  test('skips messages whose content is not a ModelMessage record', () => {
    const broken = {
      id: 'x',
      sessionId: 's1',
      seq: 0,
      role: 'user',
      content: 'raw string',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as unknown as AgentMessageDto;

    expect(parsePersistedMessages([broken]).blocks).toEqual([]);
  });

  test('skips unknown roles and non-array tool content', () => {
    const { blocks, toolBlocksById } = parsePersistedMessages([
      message(0, 'system', 'you are a bot'),
      message(1, 'assistant', [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: {} },
      ]),
      message(2, 'tool', { type: 'tool-result', toolCallId: 'tc-1', output: 'ok' }),
    ]);

    expect(blocks.map(summarize)).toEqual(['tool-call:m1p0:send_input:tc-1']);
    expect(toolBlocksById.get('tc-1')?.resolved).toBe(false);
  });

  test('later tool-call with the same id replaces the paired target', () => {
    const { blocks, toolBlocksById } = parsePersistedMessages([
      message(0, 'assistant', [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'a' } },
      ]),
      message(1, 'assistant', [
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'send_input', input: { text: 'b' } },
      ]),
      message(2, 'tool', [{ type: 'tool-result', toolCallId: 'tc-1', output: 'ok' }]),
    ]);

    expect(blocks).toHaveLength(2);
    const first = blocks[0];
    const second = blocks[1];
    if (first.kind !== 'tool-call' || second.kind !== 'tool-call') {
      throw new Error('expected tool-call blocks');
    }
    expect(first.call.resolved).toBe(false);
    expect(second.call.resolved).toBe(true);
    expect(toolBlocksById.get('tc-1')).toBe(second.call);
  });
});
