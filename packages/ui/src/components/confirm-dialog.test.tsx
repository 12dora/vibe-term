// ConfirmDialog 骨架：关闭态可渲染；扩展槽（extra / input / hideCancel / actions）不改变默认 API。

import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmDialog } from './confirm-dialog';

function render(extra?: {
  extra?: ReactNode;
  input?: { label: string; value: string; onChange: (value: string) => void; testId?: string };
  hideCancel?: boolean;
  actions?: Array<{ label: string; onClick: () => void; testId?: string }>;
}): string {
  return renderToStaticMarkup(
    <ConfirmDialog
      open={false}
      title="标题"
      cancelLabel="取消"
      confirmLabel="确认"
      onConfirm={() => undefined}
      extra={extra?.extra}
      input={extra?.input}
      hideCancel={extra?.hideCancel}
      actions={extra?.actions}
    >
      正文
    </ConfirmDialog>
  );
}

describe('ConfirmDialog', () => {
  test('关闭态可渲染，不抛错', () => {
    expect(() => render()).not.toThrow();
  });

  test('带 extra / input / hideCancel / actions 同样可渲染', () => {
    expect(() =>
      render({
        extra: <p data-testid="confirm-extra">清单</p>,
        input: { label: '原因', value: '', onChange: () => undefined, testId: 'confirm-reason' },
        hideCancel: true,
      })
    ).not.toThrow();
    expect(() =>
      render({
        actions: [{ label: '再查一次', onClick: () => undefined, testId: 'confirm-recheck' }],
      })
    ).not.toThrow();
  });
});
