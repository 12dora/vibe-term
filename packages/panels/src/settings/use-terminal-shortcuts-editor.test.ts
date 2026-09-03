import { describe, expect, test } from 'bun:test';

import type { TerminalShortcutItem } from '@tmex/shared';

import {
  appendActionShortcut,
  appendSendShortcut,
  defaultShortcutDraft,
  isShortcutDraftDirty,
  removeShortcut,
  reorderShortcuts,
  sameShortcutItems,
  setShortcutLabel,
  setShortcutPayload,
  shouldAdoptServerShortcuts,
} from './use-terminal-shortcuts-editor';

function send(id: string, label: string, payload: string): TerminalShortcutItem {
  return { id, type: 'send', label, payload };
}

const baseItems: TerminalShortcutItem[] = [
  send('a', 'ESC', '\x1b'),
  send('b', 'CTRL-C', '\x03'),
  send('c', 'TAB', '\t'),
];

describe('sameShortcutItems', () => {
  test('忽略对象键顺序，只比较归一化字段', () => {
    const reordered: TerminalShortcutItem[] = [
      { payload: '\x1b', label: 'ESC', type: 'send', id: 'a' },
      { payload: '\x03', label: 'CTRL-C', type: 'send', id: 'b' },
      { payload: '\t', label: 'TAB', type: 'send', id: 'c' },
    ];
    expect(sameShortcutItems(baseItems, reordered)).toBe(true);
  });

  test('长度、顺序或字段不同即判为不同', () => {
    expect(sameShortcutItems(baseItems, baseItems.slice(0, 2))).toBe(false);
    expect(sameShortcutItems(baseItems, reorderShortcuts(baseItems, 'a', 'c'))).toBe(false);
    expect(sameShortcutItems(baseItems, setShortcutLabel(baseItems, 'a', 'Esc'))).toBe(false);
  });

  test('五个字段逐个改动都能被识别', () => {
    const base: TerminalShortcutItem[] = [{ id: 'x', type: 'send', label: 'ESC', payload: '\x1b' }];
    const variants: TerminalShortcutItem[][] = [
      [{ id: 'y', type: 'send', label: 'ESC', payload: '\x1b' }],
      [{ id: 'x', type: 'action', action: 'paste', label: 'ESC' }],
      [{ id: 'x', type: 'send', label: 'Esc', payload: '\x1b' }],
      [{ id: 'x', type: 'send', label: 'ESC', payload: '\x1c' }],
      [{ id: 'x', type: 'send', label: 'ESC', payload: '\x1b', action: 'paste' }],
    ];
    for (const variant of variants) {
      expect(sameShortcutItems(base, variant)).toBe(false);
    }
  });

  test('比较只看这五个字段，多余字段不影响判定', () => {
    const base: TerminalShortcutItem[] = [{ id: 'x', type: 'send', label: 'ESC', payload: 'e' }];
    const extra = [{ id: 'x', type: 'send', label: 'ESC', payload: 'e', extra: 1 }];
    expect(sameShortcutItems(base, extra as TerminalShortcutItem[])).toBe(true);
  });

  test('缺省 payload/action 与 null 等价', () => {
    const withUndefined: TerminalShortcutItem[] = [
      { id: 'x', type: 'action', action: 'paste', label: '' },
    ];
    const withNothing: TerminalShortcutItem[] = [
      { id: 'x', type: 'action', action: 'paste', label: '', payload: undefined },
    ];
    expect(sameShortcutItems(withUndefined, withNothing)).toBe(true);
  });
});

describe('isShortcutDraftDirty', () => {
  test('无基线时永不 dirty', () => {
    expect(isShortcutDraftDirty({ items: baseItems, useIcons: false }, null)).toBe(false);
  });

  test('条目或 useIcons 任一不同即 dirty', () => {
    const baseline = { items: baseItems, useIcons: false };
    expect(
      isShortcutDraftDirty({ items: baseItems.map((i) => ({ ...i })), useIcons: false }, baseline)
    ).toBe(false);
    expect(isShortcutDraftDirty({ items: baseItems, useIcons: true }, baseline)).toBe(true);
    expect(
      isShortcutDraftDirty(
        { items: setShortcutLabel(baseItems, 'a', 'Esc'), useIcons: false },
        baseline
      )
    ).toBe(true);
  });
});

describe('appendSendShortcut', () => {
  test('重复添加同一按键会追加为独立条目（仅 id 不同）', () => {
    const once = appendSendShortcut(baseItems, 'CTRL-C', '\x03', 'dup-1');
    const twice = appendSendShortcut(once, 'CTRL-C', '\x03', 'dup-2');
    expect(twice).toHaveLength(5);
    expect(twice.filter((item) => item.payload === '\x03').map((item) => item.id)).toEqual([
      'b',
      'dup-1',
      'dup-2',
    ]);
  });

  test('label 为空时回退到 payload', () => {
    const next = appendSendShortcut([], '', '\x03', 'n1');
    expect(next[0]).toEqual({ id: 'n1', type: 'send', label: '\x03', payload: '\x03' });
  });

  test('payload 为空视为无效录入，原样返回', () => {
    expect(appendSendShortcut(baseItems, 'X', '', 'n1')).toBe(baseItems);
  });
});

describe('appendActionShortcut', () => {
  test('追加 action 条目且 label 留空由视图兜底', () => {
    const next = appendActionShortcut(baseItems, 'scrollToBottom', 'act-1');
    expect(next).toHaveLength(4);
    expect(next[3]).toEqual({ id: 'act-1', type: 'action', action: 'scrollToBottom', label: '' });
    expect(baseItems).toHaveLength(3);
  });
});

describe('removeShortcut', () => {
  test('按 id 删除并保持其余顺序', () => {
    expect(removeShortcut(baseItems, 'b').map((item) => item.id)).toEqual(['a', 'c']);
  });

  test('id 不存在时列表内容不变', () => {
    expect(removeShortcut(baseItems, 'zzz').map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('reorderShortcuts', () => {
  test('把拖拽项移动到目标位置', () => {
    expect(reorderShortcuts(baseItems, 'a', 'c').map((item) => item.id)).toEqual(['b', 'c', 'a']);
    expect(reorderShortcuts(baseItems, 'c', 'a').map((item) => item.id)).toEqual(['c', 'a', 'b']);
  });

  test('同一项或未知 id 原样返回', () => {
    expect(reorderShortcuts(baseItems, 'b', 'b')).toBe(baseItems);
    expect(reorderShortcuts(baseItems, 'b', 'zzz')).toBe(baseItems);
    expect(reorderShortcuts(baseItems, 'zzz', 'b')).toBe(baseItems);
  });
});

describe('setShortcutLabel / setShortcutPayload', () => {
  test('只改命中项，其余引用不变', () => {
    const next = setShortcutLabel(baseItems, 'b', 'Ctrl-C');
    expect(next[1]?.label).toBe('Ctrl-C');
    expect(next[0]).toBe(baseItems[0]);
  });

  test('payload 更新写入解析后的原始序列', () => {
    expect(setShortcutPayload(baseItems, 'c', '\r')[2]?.payload).toBe('\r');
  });
});

describe('isShortcutDraftDirty', () => {
  const baseline = { items: baseItems, useIcons: false };

  test('未初始化基线时永不 dirty', () => {
    expect(isShortcutDraftDirty({ items: [], useIcons: true }, null)).toBe(false);
  });

  test('与基线一致时不 dirty', () => {
    expect(isShortcutDraftDirty({ items: [...baseItems], useIcons: false }, baseline)).toBe(false);
  });

  test('条目或图标开关任一变化即 dirty', () => {
    expect(
      isShortcutDraftDirty({ items: removeShortcut(baseItems, 'a'), useIcons: false }, baseline)
    ).toBe(true);
    expect(isShortcutDraftDirty({ items: baseItems, useIcons: true }, baseline)).toBe(true);
  });

  test('保存后以服务器返回值为新基线，回到不 dirty', () => {
    const edited = appendActionShortcut(baseItems, 'paste', 'act-1');
    expect(isShortcutDraftDirty({ items: edited, useIcons: false }, baseline)).toBe(true);
    const savedBaseline = { items: edited, useIcons: false };
    expect(isShortcutDraftDirty({ items: edited, useIcons: false }, savedBaseline)).toBe(false);
  });

  test('重置到默认值相对空基线为 dirty', () => {
    const draft = defaultShortcutDraft();
    expect(draft.useIcons).toBe(false);
    expect(isShortcutDraftDirty(draft, { items: [], useIcons: false })).toBe(true);
  });
});

describe('shouldAdoptServerShortcuts', () => {
  const server = { items: baseItems, useIcons: false };

  test('基线为空（首次加载）总是采纳', () => {
    expect(shouldAdoptServerShortcuts(server, null, { items: [], useIcons: false })).toBe(true);
  });

  test('服务器与基线一致时不动作，避免自循环', () => {
    expect(shouldAdoptServerShortcuts(server, { items: baseItems, useIcons: false }, server)).toBe(
      false
    );
  });

  test('他端更新且本地草稿干净时跟随', () => {
    const baseline = { items: removeShortcut(baseItems, 'c'), useIcons: false };
    expect(shouldAdoptServerShortcuts(server, baseline, baseline)).toBe(true);
  });

  test('本地草稿已编辑时不覆盖用户输入', () => {
    const baseline = { items: removeShortcut(baseItems, 'c'), useIcons: false };
    const draft = { items: setShortcutLabel(baseline.items, 'a', 'Esc'), useIcons: false };
    expect(shouldAdoptServerShortcuts(server, baseline, draft)).toBe(false);
  });
});
