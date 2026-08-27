import { describe, expect, test } from 'bun:test';

import type { UiToolCall } from '@tmex/stores';

import { TOOL_BRIEFS, actionBrief } from './tool-brief';

function call(toolName: string, input: unknown, output?: unknown): UiToolCall {
  return {
    toolCallId: 'tc-1',
    toolName,
    input,
    output,
    isError: false,
    denied: false,
    resolved: output !== undefined,
  };
}

const cases: Array<{ name: string; call: UiToolCall; expected: string }> = [
  {
    name: 'send_input: 文本截断到 40 字符',
    call: call('send_input', { text: 'a'.repeat(50) }),
    expected: 'a'.repeat(40),
  },
  {
    name: 'send_input: 文本与按键计数拼接',
    call: call('send_input', { text: 'ls', keys: ['Enter'], combos: [{ key: 'c' }] }),
    expected: 'ls · +2 keys',
  },
  {
    name: 'send_input: 单个按键用单数',
    call: call('send_input', { keys: ['Enter'] }),
    expected: '+1 key',
  },
  { name: 'send_input: 空输入', call: call('send_input', {}), expected: '(empty)' },
  {
    name: 'read_screen: 输出带行数',
    call: call('read_screen', {}, { rows: 24 }),
    expected: '(24 rows)',
  },
  { name: 'read_screen: 无行数', call: call('read_screen', {}), expected: '(screen)' },
  {
    name: 'run_command: 命令截断到 60 字符',
    call: call('run_command', { command: 'b'.repeat(80) }),
    expected: 'b'.repeat(60),
  },
  { name: 'run_command: 空命令', call: call('run_command', {}), expected: '(command)' },
  {
    name: 'web_search: 查询词',
    call: call('web_search', { query: 'tmux agent' }),
    expected: 'tmux agent',
  },
  { name: 'web_search: 空查询', call: call('web_search', {}), expected: '(query)' },
  {
    name: 'fetch_url: URL',
    call: call('fetch_url', { url: 'https://example.com' }),
    expected: 'https://example.com',
  },
  { name: 'fetch_url: 空 URL', call: call('fetch_url', {}), expected: '(url)' },
  { name: 'get_pane_info: 固定文案', call: call('get_pane_info', {}), expected: '(pane info)' },
  {
    name: '未知工具：序列化 input 并截断',
    call: call('mcp__custom__do', { a: 1 }),
    expected: '{\n  "a": 1\n}',
  },
  { name: '未知工具：input 为空字符串', call: call('mcp__custom__do', ''), expected: '' },
];

describe('actionBrief', () => {
  for (const item of cases) {
    test(item.name, () => {
      expect(actionBrief(item.call)).toBe(item.expected);
    });
  }

  test('覆盖全部已注册工具', () => {
    const covered = new Set(cases.map((item) => item.call.toolName));
    for (const toolName of TOOL_BRIEFS.keys()) {
      expect(covered.has(toolName)).toBe(true);
    }
  });

  test('非对象 input 退化为空对象', () => {
    expect(actionBrief(call('send_input', ['not', 'a', 'record']))).toBe('(empty)');
    expect(actionBrief(call('web_search', null))).toBe('(query)');
  });

  test('与 Object.prototype 同名的工具名仍走兜底', () => {
    for (const toolName of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(actionBrief(call(toolName, { a: 1 }))).toBe('{\n  "a": 1\n}');
    }
  });
});
