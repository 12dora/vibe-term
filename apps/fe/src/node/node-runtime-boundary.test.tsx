// NodeRuntimeBoundary 的路由 → 运行时映射。无 DOM 测试环境，用 react-dom/server 静态渲染
// （运行时在渲染期就已解析，effect 只负责引用计数）。

import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter, Route, Routes } = await import('react-router');
const { useRuntime } = await import('@tmex/stores/react');
const { NodeRuntimeBoundary } = await import('./node-runtime-boundary');
const { appNodeRuntimes, nodeQueryClient } = await import('./node-runtimes');

function RuntimeProbe() {
  const runtime = useRuntime();
  return (
    <span
      data-node-id={runtime.nodeId}
      data-base-url={runtime.apiClient.baseUrl}
      data-storage-prefix={runtime.storagePrefix}
      data-app-path={runtime.host.appPath?.('/devices/d1') ?? '/devices/d1'}
    />
  );
}

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/n/:nodeId/*"
          element={
            <NodeRuntimeBoundary>
              <RuntimeProbe />
            </NodeRuntimeBoundary>
          }
        />
        <Route
          path="*"
          element={
            <NodeRuntimeBoundary>
              <RuntimeProbe />
            </NodeRuntimeBoundary>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('NodeRuntimeBoundary', () => {
  test('/n/:nodeId 路由渲染对应 node 的运行时', () => {
    const markup = renderAt('/n/node-a/devices/d1');
    expect(markup).toContain('data-node-id="node-a"');
    expect(markup).toContain('data-base-url="/n/node-a"');
    expect(markup).toContain('data-storage-prefix="n:node-a:"');
    expect(markup).toContain('data-app-path="/n/node-a/devices/d1"');
  });

  test('不同 nodeId 渲染不同运行时', () => {
    const a = renderAt('/n/node-a/devices/d1');
    const b = renderAt('/n/node-b/devices/d1');
    expect(a).toContain('data-base-url="/n/node-a"');
    expect(b).toContain('data-base-url="/n/node-b"');
    expect(appNodeRuntimes.get('node-a').runtime).not.toBe(appNodeRuntimes.get('node-b').runtime);
  });

  test('旧路由（无 /n 前缀）等价于 self：URL 与 storage key 与单 node 时一致', () => {
    const markup = renderAt('/devices/d1');
    expect(markup).toContain('data-node-id="self"');
    expect(markup).toContain('data-base-url=""');
    expect(markup).toContain('data-storage-prefix=""');
    expect(markup).toContain('data-app-path="/devices/d1"');
  });

  test('/n/self/... 与旧路由是同一个运行时', () => {
    expect(appNodeRuntimes.get('self').runtime).toBe(appNodeRuntimes.get('').runtime);
    renderAt('/n/self/settings');
    expect(appNodeRuntimes.get('self').apiClient.baseUrl).toBe('');
  });
});

interface DevicesData {
  devices: { id: string }[];
}

describe('每 node 的 QueryClient 缓存隔离', () => {
  test('不同 node 的 QueryClient 是不同实例，缓存互不可见', () => {
    const selfClient = nodeQueryClient('self');
    const aClient = nodeQueryClient('node-a');
    expect(selfClient).not.toBe(aClient);
    expect(nodeQueryClient('node-a')).toBe(aClient);

    const devicesKey = ['devices'] as const;
    selfClient.setQueryData<DevicesData>(devicesKey, { devices: [{ id: 'self-device' }] });
    aClient.setQueryData<DevicesData>(devicesKey, { devices: [{ id: 'a-device' }] });

    expect(selfClient.getQueryData<DevicesData>(devicesKey)).toEqual({
      devices: [{ id: 'self-device' }],
    });
    expect(aClient.getQueryData<DevicesData>(devicesKey)).toEqual({
      devices: [{ id: 'a-device' }],
    });

    // 一个 node 清空缓存不影响另一个 node
    aClient.clear();
    expect(aClient.getQueryData<DevicesData>(devicesKey)).toBeUndefined();
    expect(selfClient.getQueryData<DevicesData>(devicesKey)).toEqual({
      devices: [{ id: 'self-device' }],
    });
  });
});
