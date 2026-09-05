// 新建对话框的预选类型：SSH 引导路径要求打开即是 SSH，用户不必再选一次。
// Base UI 的 Dialog 服务端渲染不出内容（portal 挂在 effect 里），这里把对话框外壳换成透传的
// div（做法同 tool-call-card.dialog.test.tsx），只为把表单本体渲染出来做断言。

import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { devicesQueryKey } from '@tmex/api-client';
import { I18N_RESOURCES } from '@tmex/shared';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';

installWindowStorage();

type ShellProps = { children?: ReactNode } & Record<string, unknown>;
const shell =
  (tag: 'div' | 'p' | 'h2') =>
  ({ children, open: _open, onOpenChange: _onOpenChange, ...rest }: ShellProps) => {
    const Tag = tag;
    return <Tag {...rest}>{children}</Tag>;
  };

mock.module('@tmex/ui/dialog', () => ({
  Dialog: shell('div'),
  DialogContent: shell('div'),
  DialogHeader: shell('div'),
  DialogTitle: shell('h2'),
  DialogDescription: shell('p'),
  DialogFooter: shell('div'),
}));

const { DeviceDialog } = await import('./device-dialog');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

let storageSeq = 0;

function renderCreateDialog(initialType?: 'local' | 'ssh'): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `device-dialog-initial-type-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <DeviceDialog
              mode="create"
              initialType={initialType}
              nodeContext={{ runtimeNodeId: 'self', name: '', isSelf: true }}
              queryKey={devicesQueryKey}
              onClose={() => undefined}
            />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('DeviceDialog 的预选类型', () => {
  test('initialType=ssh 时开局就是 SSH：连接与认证区块直接在', () => {
    const html = renderCreateDialog('ssh');
    expect(html).toContain('data-device-kind="ssh"');
    expect(html).toContain('id="create-device-host"');
    expect(html).toContain('id="create-device-username"');
    expect(html).toContain('data-testid="device-auth-mode-select"');
  });

  test('不给预选时仍是本地设备，没有 SSH 专属字段', () => {
    const html = renderCreateDialog();
    expect(html).toContain('data-device-kind="local"');
    expect(html).not.toContain('id="create-device-host"');
    expect(html).not.toContain('data-testid="device-auth-mode-select"');
  });
});
