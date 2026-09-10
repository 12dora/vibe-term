// 面板的三条渲染分支：加载中 / 空态 / 卡片网格。bun test 无 DOM，用 react-dom/server 静态渲染，
// 列表数据直接塞进 query 缓存（静态渲染跑不了 effect，也就发不出请求）。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { devicesQueryKey } from '@vibeterm/api-client';
import type { Device, FileRootDto } from '@vibeterm/shared';
import { I18N_RESOURCES } from '@vibeterm/shared';
import { createAppRuntime } from '@vibeterm/stores';
import { RuntimeProvider } from '@vibeterm/stores/react';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import { DeviceManagementPanel } from './device-management-panel';

installWindowStorage();

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const DEVICE: Device = {
  id: 'dev-1',
  name: '书房',
  type: 'local',
  authMode: 'auto',
  sortOrder: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const OTHER_DEVICE: Device = { ...DEVICE, id: 'dev-2', name: '客厅', sortOrder: 0 };

const DEVICE_ROOT: FileRootDto = {
  id: 'root-1',
  deviceId: DEVICE.id,
  deviceName: DEVICE.name,
  deviceType: 'local',
  path: '/srv/data',
  name: 'data',
  enabled: true,
  sortOrder: 0,
};

let storageSeq = 0;

function renderPanel(
  options: {
    devices?: Device[];
    offline?: boolean;
    roots?: FileRootDto[];
    /** 冷启动首帧的占位（宿主把本地设备快照挂在每 node 的 QueryClient 缺省上） */
    placeholderDevices?: Device[];
  } = {}
): string {
  const queryClient = new QueryClient();
  if (options.placeholderDevices) {
    queryClient.setQueryDefaults(devicesQueryKey, {
      placeholderData: { devices: options.placeholderDevices },
    });
  }
  if (options.devices) queryClient.setQueryData(devicesQueryKey, { devices: options.devices });
  if (options.roots) queryClient.setQueryData(['files', 'roots'], { roots: options.roots });
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `device-panel-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider runtime={runtime}>
            <DeviceManagementPanel offline={options.offline} />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('DeviceManagementPanel 的渲染分支', () => {
  test('缓存里还没有列表时是设备卡片形状的占位，不渲染网格', () => {
    const html = renderPanel();
    expect(html).toContain('data-testid="devices-loading"');
    expect(html).toContain('加载中');
    expect(html).toContain('border-dashed');
    expect(html).not.toContain('data-testid="devices-grid"');
    expect(html).not.toContain('data-testid="devices-add-empty"');
  });

  test('占位与网格互斥：列表到了就没有占位', () => {
    const html = renderPanel({ devices: [DEVICE] });
    expect(html).toContain('data-testid="devices-grid"');
    expect(html).not.toContain('data-testid="devices-loading"');
  });

  test('空列表给出「添加设备」空态', () => {
    const html = renderPanel({ devices: [] });
    expect(html).toContain('data-testid="devices-add-empty"');
    expect(html).not.toContain('data-testid="devices-grid"');
  });

  test('离线且没有任何已知设备时是离线空态，不给添加入口', () => {
    const html = renderPanel({ offline: true });
    expect(html).toContain('data-testid="devices-offline-empty"');
    expect(html).not.toContain('data-testid="devices-add-empty"');
  });

  test('有设备时渲染网格，卡片按 sortOrder 排序并带拖动把手', () => {
    const html = renderPanel({ devices: [DEVICE, OTHER_DEVICE] });
    expect(html).toContain('data-testid="devices-grid"');
    expect(html.indexOf('device-card-slot-dev-2')).toBeLessThan(
      html.indexOf('device-card-slot-dev-1')
    );
    expect(html).toContain('data-testid="device-card-handle-dev-1"');
    expect(html).not.toContain('data-testid="devices-offline-hint"');
  });

  test('冷启动首帧的占位快照照常画网格（这就是不再转菊花的那一帧）', () => {
    const html = renderPanel({ placeholderDevices: [DEVICE, OTHER_DEVICE] });
    expect(html).toContain('data-testid="devices-grid"');
    expect(html).not.toContain('data-testid="devices-loading"');
    expect(html).toContain('data-testid="device-card-slot-dev-1"');
  });

  test('占位期间不给拖动把手：缓存里没有可回滚的基线，提交的还是一份可能过期的顺序', () => {
    const html = renderPanel({ placeholderDevices: [DEVICE, OTHER_DEVICE] });
    expect(html).not.toContain('data-testid="device-card-handle-dev-1"');
    // 真列表到了才恢复
    expect(renderPanel({ devices: [DEVICE, OTHER_DEVICE] })).toContain(
      'data-testid="device-card-handle-dev-1"'
    );
  });

  test('离线时用缓存里的列表渲染，带离线提示且没有拖动把手', () => {
    const html = renderPanel({ devices: [DEVICE, OTHER_DEVICE], offline: true });
    expect(html).toContain('data-testid="devices-offline-hint"');
    expect(html).toContain('data-testid="devices-grid"');
    expect(html).not.toContain('data-testid="device-card-handle-dev-1"');
  });
});

/** 含指定 testid 的那个标签 */
function tagOf(html: string, testId: string): string | null {
  const marker = `data-testid="${testId}"`;
  const index = html.indexOf(marker);
  if (index === -1) return null;
  return html.slice(html.lastIndexOf('<', index), html.indexOf('>', index) + 1);
}

// 文件根由列表查一次后按设备下发（每张卡片各订阅一次会重复整表扫描），
// 归并结果必须仍然逐设备区分。
describe('DeviceGrid 下发的文件根归属', () => {
  test('只有配过目录的设备文件开关可用', () => {
    const html = renderPanel({ devices: [DEVICE, OTHER_DEVICE], roots: [DEVICE_ROOT] });
    expect(tagOf(html, 'device-card-sidebar-files-dev-1')).not.toContain('aria-disabled="true"');
    expect(tagOf(html, 'device-card-sidebar-files-dev-2')).toContain('aria-disabled="true"');
  });

  test('一个目录都没配时所有设备的文件开关都禁用', () => {
    const html = renderPanel({ devices: [DEVICE, OTHER_DEVICE], roots: [] });
    expect(tagOf(html, 'device-card-sidebar-files-dev-1')).toContain('aria-disabled="true"');
    expect(tagOf(html, 'device-card-sidebar-files-dev-2')).toContain('aria-disabled="true"');
  });

  test('离线时不再去要列表，但缓存里的目录照样算数', () => {
    const html = renderPanel({ devices: [DEVICE], offline: true, roots: [DEVICE_ROOT] });
    expect(tagOf(html, 'device-card-sidebar-files-dev-1')).not.toContain('aria-disabled="true"');
  });
});
