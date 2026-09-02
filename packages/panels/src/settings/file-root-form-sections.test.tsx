// 文件根表单的两个字段：路径行的「浏览…」按钮（选中设备前禁用），
// 以及单设备模式下设备字段只读。无 DOM 环境用 react-dom/server 静态渲染断言结构。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClient } from '@tmex/api-client';
import type { Device } from '@tmex/shared';
import { I18N_RESOURCES } from '@tmex/shared';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';

import { FileRootDeviceField, FileRootPathField } from './file-root-form-sections';
import type { FileRootFormModel } from './use-file-root-form';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const DEVICES = [
  { id: 'd1', name: '书房', type: 'local' },
  { id: 'd2', name: '服务器', type: 'ssh' },
] as Device[];

function formModel(overrides: Partial<FileRootFormModel> = {}): FileRootFormModel {
  const deviceId = overrides.deviceId ?? '';
  return {
    isEdit: false,
    locked: false,
    deviceId,
    setDeviceId: () => undefined,
    path: '',
    setPath: () => undefined,
    enabled: true,
    deviceOptions: DEVICES,
    selectedDevice: DEVICES.find((device) => device.id === deviceId),
    canSubmit: false,
    isPending: false,
    submit: () => undefined,
    browseClient: new ApiClient(''),
    ...overrides,
  };
}

let runtimeSeq = 0;

function render(node: ReactElement): string {
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `file-root-form-test-${runtimeSeq++}:`,
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeProvider runtime={runtime}>{node}</RuntimeProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

/** 取「浏览…」按钮的开始标签：class 里带 `disabled:` 前缀类，只能按属性判断禁用态。 */
function browseButtonTag(html: string): string {
  const match = html.match(/<button[^>]*data-testid="settings-files-path-browse"/);
  expect(match).not.toBeNull();
  return match?.[0] ?? '';
}

describe('FileRootPathField', () => {
  test('未选设备时「浏览…」禁用', () => {
    const html = render(<FileRootPathField form={formModel()} />);
    expect(browseButtonTag(html)).toContain('disabled=""');
  });

  test('选中设备后「浏览…」可用，路径输入框保留当前值', () => {
    const html = render(<FileRootPathField form={formModel({ deviceId: 'd1', path: '/srv' })} />);
    expect(browseButtonTag(html)).not.toContain('disabled=""');
    expect(html).toContain('value="/srv"');
  });
});

describe('FileRootDeviceField', () => {
  test('默认新增模式给出设备下拉', () => {
    const html = render(
      <FileRootDeviceField form={formModel()} devices={DEVICES} root={undefined} />
    );
    expect(html).toContain('data-testid="settings-files-device-select"');
    expect(html).not.toContain('data-testid="settings-files-device-readonly"');
  });

  test('单设备模式隐藏下拉，只读展示锁定的设备', () => {
    const html = render(
      <FileRootDeviceField
        form={formModel({ locked: true, deviceId: 'd2' })}
        devices={DEVICES}
        root={undefined}
      />
    );
    expect(html).not.toContain('data-testid="settings-files-device-select"');
    expect(html).toContain('data-testid="settings-files-device-readonly"');
    expect(html).toContain('服务器');
  });
});
