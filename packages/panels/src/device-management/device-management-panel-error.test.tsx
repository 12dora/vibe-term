// 加载失败三分支的渲染：需重新登录 / 节点不可达（带原因）/ 通用失败，各自带重试按钮。
// 无 DOM 环境，用 react-dom/server 静态渲染；失败态直接由 prefetchQuery 写进 query 缓存。

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, NODE_UNREACHABLE, devicesQueryKey } from '@tmex/api-client';
import { I18N_RESOURCES } from '@tmex/shared';
import { createAppRuntime } from '@tmex/stores';
import { RuntimeProvider } from '@tmex/stores/react';
import { installWindowStorage } from '@tmex/stores/test-utils';
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

const NODE_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

let storageSeq = 0;

async function renderFailedPanel(error: unknown): Promise<string> {
  // `retryOnMount: false` 是必需的：react-query 的乐观结果会把「挂载即重试」的错误态
  // 当成 pending（`fetchState` 在 data 为 undefined 时清掉 error），静态渲染看不到失败分支。
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  await queryClient.prefetchQuery({
    queryKey: devicesQueryKey,
    queryFn: () => Promise.reject(error),
    retry: false,
  });
  const runtime = createAppRuntime({
    nodeId: 'self',
    storagePrefix: `device-panel-error-test-${storageSeq++}:`,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider runtime={runtime}>
            <DeviceManagementPanel />
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('DeviceManagementPanel 的加载失败分支', () => {
  test('NODE_LOGIN_REQUIRED 提示需重新登录，并给重试', async () => {
    const html = await renderFailedPanel(
      new ApiError(401, 'via_mismatch', {
        code: 'NODE_LOGIN_REQUIRED',
        error: 'via_mismatch',
        nodeId: NODE_ID,
      })
    );
    expect(html).toContain('data-testid="devices-load-error"');
    expect(html).toContain('data-error-kind="loginRequired"');
    expect(html).toContain('该节点需重新登录');
    expect(html).toContain('data-testid="devices-load-retry"');
    expect(html).not.toContain('data-testid="devices-grid"');
  });

  test('NODE_UNREACHABLE 带上后端给的原因串', async () => {
    const html = await renderFailedPanel(
      new ApiError(503, NODE_UNREACHABLE, {
        code: NODE_UNREACHABLE,
        nodeId: NODE_ID,
        reason: '最近一次连接失败：超时',
      })
    );
    expect(html).toContain('data-error-kind="unreachable"');
    expect(html).toContain('最近一次连接失败：超时');
    expect(html).toContain('data-testid="devices-load-retry"');
  });

  test('没有 reason 的 NODE_UNREACHABLE 用通用不可达文案', async () => {
    const html = await renderFailedPanel(
      new ApiError(503, NODE_UNREACHABLE, { code: NODE_UNREACHABLE, nodeId: NODE_ID })
    );
    expect(html).toContain('data-error-kind="unreachable"');
    expect(html).toContain('节点不可达');
    expect(html).not.toContain('（');
  });

  test('其它失败仍是通用文案', async () => {
    const html = await renderFailedPanel(new Error('boom'));
    expect(html).toContain('data-error-kind="generic"');
    expect(html).toContain('加载设备列表失败');
    expect(html).toContain('data-testid="devices-load-retry"');
  });
});
