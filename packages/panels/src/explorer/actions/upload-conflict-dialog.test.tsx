// AlertDialog 服务端渲染不出内容（portal 挂在 effect 里），这里把 ConfirmDialog 换成把收到的
// props 摊平成 HTML 的外壳，断言 UploadConflictDialog 传下去的标题 / 正文 / 清单 / 三个按钮。

import { describe, expect, mock, test } from 'bun:test';
import { I18N_RESOURCES } from '@vibeterm/shared';
import type { ConfirmDialogProps } from '@vibeterm/ui/confirm-dialog';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import type { UploadConflictChoice } from './upload-conflict-dialog';

let captured: ConfirmDialogProps | null = null;

mock.module('@vibeterm/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: ConfirmDialogProps) => {
    captured = props;
    return (
      <div data-testid={props.testId} data-open={props.open}>
        <h2>{props.title}</h2>
        <p>{props.children}</p>
        {props.extra}
        {props.actions?.map((action) => (
          <button
            key={action.testId}
            type="button"
            data-testid={action.testId}
            data-variant={action.variant}
          >
            {action.label}
          </button>
        ))}
      </div>
    );
  },
}));

const { UploadConflictDialog } = await import('./upload-conflict-dialog');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function renderDialog(names: string[], onChoose: (c: UploadConflictChoice) => void = () => {}) {
  captured = null;
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <UploadConflictDialog open names={names} onChoose={onChoose} />
    </I18nextProvider>
  );
}

describe('UploadConflictDialog', () => {
  test('单个冲突：标题点名，不再列清单', () => {
    const html = renderDialog(['a.txt']);
    expect(html).toContain('<h2>「a.txt」已存在</h2>');
    expect(html).toContain('<p>替换将覆盖目标位置的现有项目。</p>');
    expect(html).not.toContain('explorer-upload-conflict-names');
  });

  test('多个冲突：标题报数量并列出名称', () => {
    const html = renderDialog(['a', 'photos/b.jpg']);
    expect(html).toContain('<h2>2 个同名项目已存在</h2>');
    expect(html.match(/<li/g)?.length).toBe(2);
    expect(html).toContain('photos/b.jpg');
  });

  test('超过 5 个：其余合并成「等 N 项」', () => {
    const html = renderDialog(Array.from({ length: 8 }, (_, i) => `file-${i}`));
    expect(html.match(/<li/g)?.length).toBe(6);
    expect(html).toContain('等 3 项');
    expect(html).not.toContain('file-5<');
  });

  test('三个按钮：取消 / 跳过 / 替换，替换按破坏性渲染', () => {
    const html = renderDialog(['a']);
    expect(html).toMatch(/explorer-upload-conflict-cancel"[^>]*>取消</);
    expect(html).toMatch(/explorer-upload-conflict-skip"[^>]*>跳过</);
    expect(html).toMatch(/conflict-replace"[^>]*data-variant="destructive"[^>]*>替换</);
  });

  test('按钮与 Esc 各自回调对应的选择', () => {
    const choices: UploadConflictChoice[] = [];
    renderDialog(['a'], (choice) => choices.push(choice));
    const props = captured as ConfirmDialogProps | null;
    for (const action of props?.actions ?? []) action.onClick();
    props?.onOpenChange?.(false);
    props?.onOpenChange?.(true);
    expect(choices).toEqual(['cancel', 'skip', 'replace', 'cancel']);
  });
});
