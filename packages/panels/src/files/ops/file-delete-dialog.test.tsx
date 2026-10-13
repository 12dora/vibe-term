// AlertDialog 服务端渲染不出内容（portal 挂在 effect 里），这里把 ConfirmDialog 换成把收到的
// props 摊平成 HTML 的外壳，断言 FileDeleteDialog 传下去的标题 / 正文 / 清单 / 按钮状态。

import { describe, expect, mock, test } from 'bun:test';
import { I18N_RESOURCES } from '@vibeterm/shared';
import type { ConfirmDialogProps } from '@vibeterm/ui/confirm-dialog';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

mock.module('@vibeterm/ui/confirm-dialog', () => ({
  ConfirmDialog: (props: ConfirmDialogProps) => (
    <div
      data-testid={props.testId}
      data-open={props.open}
      data-variant={props.variant}
      data-dismissable={props.onCancel !== undefined || props.onOpenChange !== undefined}
    >
      <h2>{props.title}</h2>
      <p>{props.children}</p>
      {props.extra}
      <button type="button" data-role="cancel" disabled={props.cancelDisabled}>
        {props.cancelLabel}
      </button>
      <button
        type="button"
        data-role="confirm"
        data-pending={props.confirmPending === true}
        disabled={props.confirmDisabled}
      >
        {props.confirmLabel}
      </button>
    </div>
  ),
}));

const { FILE_DELETE_LISTED_NAMES, FileDeleteDialog } = await import('./file-delete-dialog');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function renderDialog(names: string[], busy?: boolean): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <FileDeleteDialog
        open
        names={names}
        busy={busy}
        onConfirm={() => undefined}
        onClose={() => undefined}
      />
    </I18nextProvider>
  );
}

describe('FileDeleteDialog', () => {
  test('单项：标题点名，不再重复列清单', () => {
    const html = renderDialog(['notes.txt']);
    expect(html).toContain('<h2>删除「notes.txt」？</h2>');
    expect(html).toContain('<p>删除后无法恢复。</p>');
    expect(html).toMatch(/data-role="confirm"[^>]*>删除</);
    expect(html).toMatch(/data-role="cancel"[^>]*>取消</);
    expect(html).toContain('data-variant="destructive"');
    expect(html).not.toContain('data-testid="file-delete-names"');
  });

  test('多项：标题报数量并列出全部名称', () => {
    const html = renderDialog(['a', 'b', 'c']);
    expect(html).toContain('<h2>删除 3 个项目？</h2>');
    expect(html).toContain('data-testid="file-delete-names"');
    expect(html.match(/<li/g)?.length).toBe(3);
    expect(html).not.toContain('等 ');
  });

  test('超过上限：只列前几个，其余合并成「等 N 项」', () => {
    const names = Array.from({ length: FILE_DELETE_LISTED_NAMES + 3 }, (_, i) => `file-${i}`);
    const html = renderDialog(names);
    expect(html).toContain(`file-${FILE_DELETE_LISTED_NAMES - 1}`);
    expect(html).not.toContain(`file-${FILE_DELETE_LISTED_NAMES}<`);
    expect(html.match(/<li/g)?.length).toBe(FILE_DELETE_LISTED_NAMES + 1);
    expect(html).toContain('等 3 项');
  });

  test('busy 时两个按钮都禁用并显示进行中', () => {
    const html = renderDialog(['a', 'b'], true);
    expect(html).toMatch(/data-role="cancel"[^>]*disabled/);
    expect(html).toMatch(/data-role="confirm"[^>]*disabled/);
    expect(html).toContain('data-pending="true"');
  });

  test('busy 时 Esc / 点外面也关不掉：不再给 ConfirmDialog 任何关闭回调', () => {
    expect(renderDialog(['a'], true)).toContain('data-dismissable="false"');
    expect(renderDialog(['a'])).toContain('data-dismissable="true"');
  });

  test('空闲时按钮可点', () => {
    const html = renderDialog(['a', 'b']);
    expect(html).not.toMatch(/data-role="(cancel|confirm)"[^>]*disabled/);
    expect(html).toContain('data-pending="false"');
  });
});
