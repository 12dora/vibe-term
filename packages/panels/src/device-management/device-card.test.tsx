// 设备卡片的「显示在侧栏」开关：默认值按 node 归属（self 开、远端 node 关）。
// bun test 无 DOM，用 react-dom/server 静态渲染断言开关状态；静态渲染下 zustand 走
// `getInitialState`，所以这里只能覆盖默认值，「存过的值优先」由 stores 的单测覆盖。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { createAppRuntime, sidebarDeviceVisibilityKey } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import { DeviceCard } from './device-card';

installWindowStorage();

const DEVICE: Device = {
  id: 'dev-1',
  name: '书房',
  type: 'local',
  host: null,
  port: null,
  username: null,
  authMode: null,
  session: null,
  defaultWorkingDir: null,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
} as unknown as Device;

let storageSeq = 0;

function renderCard(runtimeNodeId: string): string {
  // 每次一个独立的 persist key：共享的内存 localStorage 不会把用例之间的偏好串起来。
  const runtime = createAppRuntime({
    nodeId: runtimeNodeId,
    storagePrefix: `device-card-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeProvider runtime={runtime}>
          <DeviceCard device={DEVICE} onEdit={() => undefined} onDelete={() => undefined} />
        </RuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

/**
 * 开关的选中态只看 `aria-checked`：class 里同时带 `data-checked:` / `data-unchecked:`
 * 两个 tailwind 变体前缀，按 data-* 属性匹配会永远命中。
 */
function switchState(html: string): string | null {
  const marker = 'data-testid="device-card-sidebar-dev-1"';
  const index = html.indexOf(marker);
  if (index === -1) return null;
  const tag = html.slice(html.lastIndexOf('<', index), html.indexOf('>', index));
  return tag.includes('aria-checked="true"') ? 'checked' : 'unchecked';
}

describe('DeviceCard 的侧栏可见性开关', () => {
  test('self 的设备默认开', () => {
    expect(switchState(renderCard('self'))).toBe('checked');
  });

  test('远端 node 的设备默认关', () => {
    expect(switchState(renderCard('n1'))).toBe('unchecked');
  });

  test('紧凑布局仍保留 e2e 依赖的选择器', () => {
    const html = renderCard('self');
    expect(html).toContain('data-testid="device-card"');
    expect(html).toContain('data-testid="device-card-connect-dev-1"');
    expect(html).toContain('data-testid="device-card-actions-dev-1"');
    expect(html).toContain('data-testid="device-card-sidebar-dev-1"');
  });

  test('开关键名按 node 归属复合，不同 node 的同名 device id 互不覆盖', () => {
    expect(sidebarDeviceVisibilityKey('self', DEVICE.id)).not.toBe(
      sidebarDeviceVisibilityKey('n1', DEVICE.id)
    );
  });
});
