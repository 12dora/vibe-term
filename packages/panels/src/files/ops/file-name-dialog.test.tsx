// Base UI 的 Dialog 服务端渲染不出内容（portal 挂在 effect 里），这里把对话框外壳换成透传的
// div（做法同 device-dialog-initial-type.test.tsx），只为把表单本体渲染出来做断言。
// i18n 不装资源：t() 原样回显 key，断言的是「用了哪条文案」而不是译文。

import { describe, expect, mock, test } from 'bun:test';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

type ShellProps = { children?: ReactNode } & Record<string, unknown>;
const shell =
  (tag: 'div' | 'h2') =>
  ({
    children,
    open: _open,
    onOpenChange: _onOpenChange,
    onOpenChangeComplete: _onOpenChangeComplete,
    initialFocus: _initialFocus,
    ...rest
  }: ShellProps) => {
    const Tag = tag;
    return <Tag {...rest}>{children}</Tag>;
  };

mock.module('@vibeterm/ui/dialog', () => ({
  Dialog: shell('div'),
  DialogContent: shell('div'),
  DialogHeader: shell('div'),
  DialogTitle: shell('h2'),
  DialogDescription: shell('div'),
  DialogFooter: shell('div'),
}));

const { FileNameDialog, fileNameDialogErrorKey, initialSelectionEnd } = await import(
  './file-name-dialog'
);

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: {},
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function renderDialog(initialName: string, takenNames?: ReadonlySet<string>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <FileNameDialog
        open
        title="标题"
        confirmLabel="确认"
        initialName={initialName}
        takenNames={takenNames}
        onSubmit={() => true}
        onClose={() => undefined}
      />
    </I18nextProvider>
  );
}

function confirmButton(html: string): string {
  const match = html.match(/<button[^>]*data-testid="file-name-confirm"[^>]*>/);
  if (!match) throw new Error('confirm button not rendered');
  return match[0];
}

describe('fileNameDialogErrorKey', () => {
  test('合法且未占用：无错误', () => {
    expect(fileNameDialogErrorKey('b.txt', 'a.txt', new Set(['a.txt']))).toBeNull();
    expect(fileNameDialogErrorKey('b.txt', 'a.txt')).toBeNull();
  });

  test('校验错误优先于重名', () => {
    expect(fileNameDialogErrorKey('', 'a.txt', new Set(['']))).toBe('files.ops.nameEmpty');
    expect(fileNameDialogErrorKey('a/b', 'a.txt')).toBe('files.ops.nameInvalid');
    expect(fileNameDialogErrorKey('a'.repeat(256), 'a.txt')).toBe('files.ops.nameTooLong');
  });

  test('与目录里别的名称相同：重名；与原名相同不算', () => {
    const taken = new Set(['a.txt', 'b.txt']);
    expect(fileNameDialogErrorKey('b.txt', 'a.txt', taken)).toBe('files.ops.nameTaken');
    expect(fileNameDialogErrorKey('a.txt', 'a.txt', taken)).toBeNull();
  });

  test('不做 trim：带空格的名称与已有名称不算同名', () => {
    expect(fileNameDialogErrorKey('b.txt ', 'a.txt', new Set(['b.txt']))).toBeNull();
  });
});

describe('initialSelectionEnd', () => {
  test('默认全选', () => {
    expect(initialSelectionEnd('notes.txt')).toBe(9);
    expect(initialSelectionEnd('未命名文件夹', false)).toBe(6);
  });

  test('selectStem 只选到最后一个点之前；点文件与无扩展名整个选中', () => {
    expect(initialSelectionEnd('notes.txt', true)).toBe(5);
    expect(initialSelectionEnd('a.tar.gz', true)).toBe(5);
    expect(initialSelectionEnd('.env', true)).toBe(4);
    expect(initialSelectionEnd('Makefile', true)).toBe(8);
  });
});

describe('FileNameDialog', () => {
  test('渲染标题、标签、初始值与确认文案，合法时确认可点', () => {
    const html = renderDialog('notes.txt');
    expect(html).toContain('<h2>标题</h2>');
    expect(html).toContain('files.ops.nameLabel');
    expect(html).toContain('value="notes.txt"');
    expect(html).toContain('common.cancel');
    expect(html).toContain('确认');
    expect(html).not.toContain('data-testid="file-name-error"');
    expect(confirmButton(html)).not.toContain(' disabled=""');
  });

  test('重命名时原名在 takenNames 里也不报重名', () => {
    const html = renderDialog('notes.txt', new Set(['notes.txt']));
    expect(html).not.toContain('files.ops.nameTaken');
    expect(confirmButton(html)).not.toContain(' disabled=""');
  });

  test('初始名称非法：字段下方给出原因并禁用确认', () => {
    const html = renderDialog('');
    expect(html).toContain('data-testid="file-name-error"');
    expect(html).toContain('files.ops.nameEmpty');
    expect(html).toContain('aria-invalid="true"');
    expect(confirmButton(html)).toContain(' disabled=""');
  });
});
