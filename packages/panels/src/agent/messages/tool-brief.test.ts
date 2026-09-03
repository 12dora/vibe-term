import { describe, expect, test } from 'bun:test';

import type { UiToolCall } from '@tmex/stores';

import { TOOL_BRIEFS, actionBrief, asBriefText } from './tool-brief';

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

describe('asBriefText', () => {
  const shapes: unknown[] = [
    { a: 1 },
    { command: 'ls -al', cwd: '/home/k' },
    { text: 'x'.repeat(500) },
    [1, 2, 3],
    Array.from({ length: 200 }, (_, i) => ({ index: i, note: 'n'.repeat(80) })),
    { nested: { deep: { deeper: 'y'.repeat(300) } } },
    { flag: true, nothing: null },
    'plain string',
    42,
  ];

  test('前 60 字符与完整序列化逐字相同', () => {
    for (const value of shapes) {
      const full = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
      expect(asBriefText(value, 60)).toBe(full.slice(0, 60));
    }
  });

  test('不为 60 字符预览读遍整个 input', () => {
    let reads = 0;
    const input: Record<string, unknown> = { head: 'h'.repeat(30) };
    for (let i = 0; i < 100; i += 1) {
      Object.defineProperty(input, `k${i}`, {
        enumerable: true,
        get: () => {
          reads += 1;
          return 'v'.repeat(200);
        },
      });
    }
    const brief = actionBrief(call('mcp__custom__do', input));
    // 断言在取到 60 字符预算后停手：只读了最前面的少数几个键（下面的完整序列化会读遍所有 getter）
    expect(reads).toBeLessThan(4);
    expect(brief).toBe((JSON.stringify(input, null, 2) as string).slice(0, 60));
  });

  test('循环引用退化为 String(value) 而不抛错', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(asBriefText(cyclic, 60)).toBe('[object Object]');
  });
});
