// 设备卡片：种类展示（本地 / SSH / 远端节点上的设备）、连接开关的三种状态、
// 「显示在侧栏」开关默认值。bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML；
// 静态渲染下 zustand 走 `getInitialState`，所以侧栏开关只能覆盖默认值，
// 「存过的值优先」由 stores 的单测覆盖。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Device } from '@tmex/shared';
import { I18N_RESOURCES } from '@tmex/shared';
import { createAppRuntime, sidebarDeviceVisibilityKey } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
import i18next from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router';
import type { DeviceConnectionAdapter, DeviceConnectionStatus } from '../device-connection';
import { DeviceCard } from './device-card';
import type { DeviceNodeContext } from './device-node-context';

installWindowStorage();

// 独立实例 + I18nextProvider：不碰 react-i18next 的全局默认实例，避免与其它测试文件互相污染。
const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const LOCAL_DEVICE: Device = {
  id: 'dev-1',
  name: '书房',
  type: 'local',
  authMode: 'auto',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SSH_DEVICE: Device = {
  ...LOCAL_DEVICE,
  type: 'ssh',
  authMode: 'agent',
  host: '10.0.0.2',
  port: 2222,
  username: 'root',
};

const SELF_CONTEXT: DeviceNodeContext = { runtimeNodeId: 'self', name: '', isSelf: true };
const REMOTE_CONTEXT: DeviceNodeContext = { runtimeNodeId: 'n1', name: '书房节点', isSelf: false };

function stubConnection(status: DeviceConnectionStatus): DeviceConnectionAdapter {
  return {
    status: () => status,
    isConnected: () => status === 'connected',
    isIntentionallyDisconnected: () => status === 'disconnected',
    connect: () => undefined,
    disconnect: () => undefined,
  };
}

let storageSeq = 0;

function renderCard(options: {
  device?: Device;
  nodeContext?: DeviceNodeContext;
  connection?: DeviceConnectionAdapter;
  offline?: boolean;
}): string {
  const nodeContext = options.nodeContext ?? SELF_CONTEXT;
  // 每次一个独立的 persist key：共享的内存 localStorage 不会把用例之间的偏好串起来。
  const runtime = createAppRuntime({
    nodeId: nodeContext.runtimeNodeId,
    storagePrefix: `device-card-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={new QueryClient()}>
          <RuntimeProvider runtime={runtime}>
            <DeviceCard
              device={options.device ?? LOCAL_DEVICE}
              nodeContext={nodeContext}
              connection={options.connection}
              offline={options.offline}
              onEdit={() => undefined}
              onDelete={() => undefined}
            />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

function occurrences(html: string, text: string): number {
  return html.split(text).length - 1;
}

/** 含某段属性的那个标签（tooltip 触发器没有 testid，只能按 data-slot 找） */
function tagWith(html: string, marker: string): string | null {
  const index = html.indexOf(marker);
  if (index === -1) return null;
  return html.slice(html.lastIndexOf('<', index), html.indexOf('>', index) + 1);
}

function tagOf(html: string, testId: string): string | null {
  const marker = `data-testid="${testId}"`;
  const index = html.indexOf(marker);
  if (index === -1) return null;
  return html.slice(html.lastIndexOf('<', index), html.indexOf('>', index) + 1);
}

/**
 * 开关的选中态只看 `aria-checked`：class 里同时带 `data-checked:` / `data-unchecked:`
 * 两个 tailwind 变体前缀，按 data-* 属性匹配会永远命中。
 */
function switchState(html: string): string | null {
  const tag = tagOf(html, 'device-card-sidebar-dev-1');
  if (!tag) return null;
  return tag.includes('aria-checked="true"') ? 'checked' : 'unchecked';
}

describe('DeviceCard 的设备种类展示', () => {
  test('本地设备的种类只出现一次，且不渲染第二行副标题', () => {
    const html = renderCard({});
    expect(occurrences(html, '本地设备')).toBe(1);
    expect(html).toContain('data-device-kind="local"');
    expect(html).not.toContain('root@');
    expect(html).not.toContain('-@-');
  });

  test('SSH 设备第二行是 user@host:port，种类 pill 说 SSH 设备', () => {
    const html = renderCard({ device: SSH_DEVICE });
    expect(html).toContain('root@10.0.0.2:2222');
    expect(occurrences(html, 'SSH 设备')).toBe(1);
    expect(html).toContain('data-device-kind="ssh"');
  });

  test('远端节点上的本机设备说「远程本地设备」，并带远端角标', () => {
    const html = renderCard({ nodeContext: REMOTE_CONTEXT });
    expect(html).toContain('远程本地设备');
    expect(html).not.toContain('书房节点');
    expect(html).toContain('data-device-kind="nodeLocal"');
    expect(html).toContain('data-testid="device-card-remote-dev-1"');
  });

  test('远端节点上的 SSH 设备说「远程 SSH 设备」', () => {
    const html = renderCard({ device: SSH_DEVICE, nodeContext: REMOTE_CONTEXT });
    expect(html).toContain('远程 SSH 设备');
    expect(html).toContain('data-device-kind="nodeSsh"');
  });

  test('本机上下文不渲染远端角标', () => {
    expect(renderCard({})).not.toContain('data-testid="device-card-remote-dev-1"');
  });
});

describe('DeviceCard 第一行的宽度分配', () => {
  test('设备名与 SSH 目标截断后挂 tooltip，全文仍在 title 上', () => {
    const html = renderCard({ device: SSH_DEVICE });
    const name = tagWith(html, 'data-slot="tooltip-trigger"');
    expect(name).toContain('truncate');
    expect(html).toContain('title="书房"');
    expect(html).toContain('title="root@10.0.0.2:2222"');
    // 触发器渲染成 div 而不是默认的 button：卡片里已经有真按钮，名称不该再进 Tab 序
    expect(name?.startsWith('<div')).toBe(true);
  });

  test('连接开关贴内容宽度，右侧不再留固定空白', () => {
    const tag = tagOf(
      renderCard({ connection: stubConnection('connected') }),
      'device-card-connect-dev-1'
    );
    expect(tag).not.toContain('min-w-[5.5rem]');
    expect(tag).not.toContain('justify-start');
    expect(tag).toContain('justify-center');
  });
});

describe('DeviceCard 的连接开关', () => {
  test('未注入 connection 时只有「打开」入口', () => {
    const html = renderCard({});
    expect(html).not.toContain('data-testid="device-card-connect-dev-1"');
    const openTag = tagOf(html, 'device-card-open-dev-1');
    expect(openTag).toContain('href="/devices/dev-1"');
    expect(html).toContain('打开');
  });

  test('已连接显示「断开」', () => {
    const html = renderCard({ connection: stubConnection('connected') });
    const tag = tagOf(html, 'device-card-connect-dev-1');
    expect(tag).toContain('data-state="connected"');
    expect(tag).toContain('data-action="disconnect"');
    expect(html).toContain('断开');
  });

  test('已断开显示「连接」', () => {
    const html = renderCard({ connection: stubConnection('disconnected') });
    const tag = tagOf(html, 'device-card-connect-dev-1');
    expect(tag).toContain('data-state="disconnected"');
    expect(tag).toContain('data-action="connect"');
  });

  test('出错也显示「连接」，可以直接重连', () => {
    const tag = tagOf(
      renderCard({ connection: stubConnection('error') }),
      'device-card-connect-dev-1'
    );
    expect(tag).toContain('data-state="error"');
    expect(tag).toContain('data-action="connect"');
  });

  test('连接中禁用按钮', () => {
    const html = renderCard({ connection: stubConnection('connecting') });
    const tag = tagOf(html, 'device-card-connect-dev-1');
    expect(tag).toContain('data-action="pending"');
    expect(tag).toContain('disabled');
    expect(html).toContain('连接中...');
  });

  test('重连中与连接中同样禁用', () => {
    const tag = tagOf(
      renderCard({ connection: stubConnection('reconnecting') }),
      'device-card-connect-dev-1'
    );
    expect(tag).toContain('data-state="reconnecting"');
    expect(tag).toContain('data-action="pending"');
  });

  test('断开中：禁用并显示「断开中...」，不闪回「连接」', () => {
    const html = renderCard({ connection: stubConnection('disconnecting') });
    const tag = tagOf(html, 'device-card-connect-dev-1');
    expect(tag).toContain('data-state="disconnecting"');
    expect(tag).toContain('data-action="pending"');
    expect(tag).toContain('disabled');
    expect(html).toContain('断开中...');
  });

  test('有 connection 时「打开」仍在，只是变成图标按钮', () => {
    const html = renderCard({ connection: stubConnection('connected') });
    expect(tagOf(html, 'device-card-open-dev-1')).toContain('href="/devices/dev-1"');
  });
});

describe('DeviceCard 的离线态', () => {
  test('节点离线：标「节点离线」、灰显，残留的 connecting 也按可点的「连接」展示', () => {
    const html = renderCard({
      nodeContext: REMOTE_CONTEXT,
      connection: stubConnection('connecting'),
      offline: true,
    });
    expect(tagOf(html, 'device-card')).toContain('data-offline="true"');
    expect(html).toContain('data-testid="device-card-offline-dev-1"');
    expect(html).toContain('节点离线');
    const toggle = tagOf(html, 'device-card-connect-dev-1');
    expect(toggle).toContain('data-state="disconnected"');
    expect(toggle).toContain('data-action="connect"');
    expect(toggle).not.toContain('disabled=""');
  });

  test('在线时不带离线标记', () => {
    const html = renderCard({ connection: stubConnection('connected') });
    expect(html).not.toContain('data-testid="device-card-offline-dev-1"');
    expect(tagOf(html, 'device-card')).not.toContain('data-offline');
  });
});

describe('DeviceCard 的侧栏可见性开关', () => {
  test('self 的设备默认开', () => {
    expect(switchState(renderCard({}))).toBe('checked');
  });

  test('远端 node 的设备默认关', () => {
    expect(switchState(renderCard({ nodeContext: REMOTE_CONTEXT }))).toBe('unchecked');
  });

  test('紧凑布局仍保留 e2e 依赖的选择器', () => {
    const html = renderCard({});
    expect(html).toContain('data-testid="device-card"');
    expect(html).toContain('data-testid="device-card-open-dev-1"');
    expect(html).toContain('data-testid="device-card-actions-dev-1"');
    expect(html).toContain('data-testid="device-card-sidebar-dev-1"');
  });

  test('开关键名按 node 归属复合，不同 node 的同名 device id 互不覆盖', () => {
    expect(sidebarDeviceVisibilityKey('self', LOCAL_DEVICE.id)).not.toBe(
      sidebarDeviceVisibilityKey('n1', LOCAL_DEVICE.id)
    );
  });
});
