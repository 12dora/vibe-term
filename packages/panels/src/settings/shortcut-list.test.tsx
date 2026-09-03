// label 输入框对齐 payload 的写法：本地草稿 + 失焦提交。
// bun test 无 DOM：mock 包住 @tmex/ui/input（转发真实实现）拿到输入框 props，直接调它的回调。

import { describe, expect, mock, test } from 'bun:test';
import { I18N_RESOURCES } from '@tmex/shared';
import type { TerminalShortcutItem } from '@tmex/shared';
import i18next from 'i18next';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

type CapturedInput = {
  'data-testid'?: string;
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onBlur?: () => void;
};

const realInput = (await import('@tmex/ui/input')) as unknown as Record<string, unknown>;
const RealInput = realInput.Input as ComponentType<CapturedInput>;
const captured: CapturedInput[] = [];

mock.module('@tmex/ui/input', () => ({
  ...realInput,
  Input: (props: CapturedInput) => {
    captured.push(props);
    return <RealInput {...props} />;
  },
}));

const { ShortcutList } = await import('./shortcut-list');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const ITEMS: TerminalShortcutItem[] = [
  { id: 'a', type: 'send', label: 'ESC', payload: '\x1b' },
  { id: 'b', type: 'action', action: 'toggleKeyboard', label: '' },
];

function renderList(onLabelChange: (id: string, label: string) => void): CapturedInput[] {
  captured.length = 0;
  renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <ShortcutList
        items={ITEMS}
        onReorder={() => undefined}
        onLabelChange={onLabelChange}
        onPayloadChange={() => undefined}
        onRemove={() => undefined}
      />
    </I18nextProvider>
  );
  return captured.slice();
}

function labelInput(inputs: CapturedInput[], id: string): CapturedInput {
  const found = inputs.find((props) => props['data-testid'] === `shortcut-editor-label-${id}`);
  if (!found) throw new Error(`label input ${id} not rendered`);
  return found;
}

describe('ShortcutList 的 label 输入框', () => {
  test('每次击键只改本地草稿，不回写数据层', () => {
    const commits: Array<[string, string]> = [];
    const input = labelInput(
      renderList((id, label) => commits.push([id, label])),
      'a'
    );
    expect(input.value).toBe('ESC');
    input.onChange?.({ target: { value: 'ES' } });
    input.onChange?.({ target: { value: 'E' } });
    input.onChange?.({ target: { value: 'EXIT' } });
    expect(commits).toEqual([]);
  });

  test('失焦提交一次', () => {
    const commits: Array<[string, string]> = [];
    const input = labelInput(
      renderList((id, label) => commits.push([id, label])),
      'a'
    );
    input.onBlur?.();
    expect(commits).toEqual([['a', 'ESC']]);
  });

  test('action 行的 label 走同一套草稿', () => {
    const commits: Array<[string, string]> = [];
    const input = labelInput(
      renderList((id, label) => commits.push([id, label])),
      'b'
    );
    expect(input.value).toBe('');
    input.onChange?.({ target: { value: '键盘' } });
    expect(commits).toEqual([]);
    input.onBlur?.();
    expect(commits).toEqual([['b', '']]);
  });
});
