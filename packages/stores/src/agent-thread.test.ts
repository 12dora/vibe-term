import { describe, expect, test } from 'bun:test';

import type { AgentMessageDto, AgentMessageRole } from '@tmex/shared';
import { type UiThreadBlock, buildThreadBlocks, unwrapToolOutput } from './agent-thread';

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

describe('buildThreadBlocks persisted message tolerance', () => {
  function message(role: AgentMessageRole, content: unknown, seq = 0): AgentMessageDto {
    return {
      id: `m${seq}`,
      sessionId: 's1',
      seq,
      role,
      content,
      createdAt: '2026-01-01T00:00:00.000Z',
    } as AgentMessageDto;
  }

  interface ShapeCase {
    name: string;
    content: unknown;
    role?: AgentMessageRole;
    expected: Array<{ kind: UiThreadBlock['kind']; key: string; text?: string; toolName?: string }>;
  }

  const userCases: ShapeCase[] = [
    {
      name: 'string content',
      content: { role: 'user', content: 'hi' },
      expected: [{ kind: 'user', key: 'm0', text: 'hi' }],
    },
    {
      name: 'part array joins text parts',
      content: { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
      expected: [{ kind: 'user', key: 'm0', text: 'a\nb' }],
    },
    {
      name: 'part array skips non-record and non-string text',
      content: { role: 'user', content: ['raw', { text: 7 }, null, { text: 'ok' }] },
      expected: [{ kind: 'user', key: 'm0', text: 'ok' }],
    },
    { name: 'empty string content', content: { role: 'user', content: '' }, expected: [] },
    { name: 'numeric content', content: { role: 'user', content: 42 }, expected: [] },
    { name: 'null content', content: { role: 'user', content: null }, expected: [] },
    { name: 'missing content field', content: { role: 'user' }, expected: [] },
    { name: 'message content is a string', content: 'not a model message', expected: [] },
    { name: 'message content is null', content: null, expected: [] },
    { name: 'message content is an array', content: [{ text: 'x' }], expected: [] },
  ];

  const assistantCases: ShapeCase[] = [
    {
      name: 'string content',
      content: { role: 'assistant', content: 'answer' },
      expected: [{ kind: 'assistant-text', key: 'm0', text: 'answer' }],
    },
    { name: 'empty string content', content: { role: 'assistant', content: '' }, expected: [] },
    { name: 'non-array object content', content: { role: 'assistant', content: {} }, expected: [] },
    {
      name: 'text / reasoning parts keyed by index',
      content: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'think' },
          { type: 'text', text: 'say' },
        ],
      },
      expected: [
        { kind: 'reasoning', key: 'm0p0', text: 'think' },
        { kind: 'assistant-text', key: 'm0p1', text: 'say' },
      ],
    },
    {
      name: 'drops empty / non-string text parts and unknown part types',
      content: {
        role: 'assistant',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 9 },
          { type: 'reasoning', text: '' },
          { type: 'file', text: 'nope' },
          null,
          'raw',
        ],
      },
      expected: [],
    },
    {
      name: 'tool-call without toolName falls back to unknown',
      content: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'tc-9' }],
      },
      expected: [{ kind: 'tool-call', key: 'm0p0', toolName: 'unknown' }],
    },
    {
      name: 'tool-call without string toolCallId is dropped',
      content: {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 12, toolName: 'x' }],
      },
      expected: [],
    },
  ];

  const otherRoleCases: ShapeCase[] = [
    {
      name: 'prototype-shaped role is ignored',
      role: '__proto__' as AgentMessageRole,
      content: { role: '__proto__', content: 'poison' },
      expected: [],
    },
    {
      name: 'constructor role is ignored',
      role: 'constructor' as AgentMessageRole,
      content: { role: 'constructor', content: 'poison' },
      expected: [],
    },
    {
      name: 'system role is ignored',
      role: 'system',
      content: { role: 'system', content: 'sys prompt' },
      expected: [],
    },
    {
      name: 'tool role with non-array content is ignored',
      role: 'tool',
      content: { role: 'tool', content: 'oops' },
      expected: [],
    },
    {
      name: 'tool role with unmatched results is ignored',
      role: 'tool',
      content: {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'missing', output: { type: 'text', value: 'v' } },
          { type: 'tool-approval-response', toolCallId: 'tc-1' },
          null,
        ],
      },
      expected: [],
    },
  ];

  for (const [group, cases, role] of [
    ['user', userCases, 'user'],
    ['assistant', assistantCases, 'assistant'],
    ['other', otherRoleCases, 'user'],
  ] as const) {
    for (const shape of cases) {
      test(`${group}: ${shape.name}`, () => {
        const blocks = buildThreadBlocks([message(shape.role ?? role, shape.content)], undefined);
        expect(blocks.map((block) => block.kind)).toEqual(shape.expected.map((it) => it.kind));
        blocks.forEach((block, index) => {
          const want = shape.expected[index];
          expect(block.key).toBe(want.key);
          if (want.text !== undefined && block.kind !== 'tool-call') {
            expect(block.text).toBe(want.text);
          }
          if (want.toolName !== undefined && block.kind === 'tool-call') {
            expect(block.call.toolName).toBe(want.toolName);
          }
        });
      });
    }
  }

  test('tool-result with non-string toolCallId cannot resolve a real call', () => {
    const blocks = buildThreadBlocks(
      [
        message('assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'run' }],
        }),
        message(
          'tool',
          {
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 5, output: { type: 'text', value: 'v' } }],
          },
          1
        ),
      ],
      undefined
    );
    const block = blocks[0];
    if (block.kind !== 'tool-call') {
      throw new Error('expected tool-call block');
    }
    expect(block.call.resolved).toBe(false);
    expect(block.call.output).toBeUndefined();
  });

  test('tool-result pairs across messages and keeps raw output shapes', () => {
    const blocks = buildThreadBlocks(
      [
        message('assistant', {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'run', input: { a: 1 } }],
        }),
        message(
          'tool',
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc-1', output: 'raw' }] },
          1
        ),
      ],
      undefined
    );
    const block = blocks[0];
    if (block.kind !== 'tool-call') {
      throw new Error('expected tool-call block');
    }
    expect(block.call.input).toEqual({ a: 1 });
    expect(block.call.output).toBe('raw');
    expect(block.call.resolved).toBe(true);
    expect(block.call.isError).toBe(false);
  });
});
