// 文件侧栏的外壳与过滤：bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML。
// 静态渲染下 zustand 走 `getInitialState`（可见性/连接表都是默认值），所以这里覆盖
// 「默认显示」「设备没连上就不显示」「node 离线只留一行提示」这三条；
// 「关掉开关就消失」由 root-visibility 的单测覆盖。

import { describe, expect, test } from 'bun:test';
import type { FileRootDto } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// SidebarProvider 在构造 state 时就读 matchMedia；这里只需要一个稳定的桌面端读数。
(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { I18N_RESOURCES } = await import('@tmex/shared');
const { createAppRuntime } = await import('@tmex/stores');
const { RuntimeProvider } = await import('@tmex/stores/react');
const i18next = (await import('i18next')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nextProvider } = await import('react-i18next');
const { MemoryRouter } = await import('react-router');
const { SidebarProvider } = await import('@tmex/ui/sidebar');
const { FilesTab } = await import('./files-tab');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const LOCAL_ROOT: FileRootDto = {
  id: 'r-local',
  deviceId: 'd-local',
  deviceName: '书房',
  deviceType: 'local',
  path: '/srv/local',
  name: 'local',
  enabled: true,
  sortOrder: 0,
};

const SSH_ROOT: FileRootDto = {
  ...LOCAL_ROOT,
  id: 'r-ssh',
  deviceId: 'd-ssh',
  deviceName: '机房',
  deviceType: 'ssh',
  path: '/srv/ssh',
  name: 'ssh',
};

let storageSeq = 0;

function renderFilesTab(options: { roots?: FileRootDto[]; nodeOffline?: boolean } = {}): string {
  const runtime = createAppRuntime({ storagePrefix: `files-tab-test-${storageSeq++}:` });
  const queryClient = new QueryClient();
  if (options.roots) {
    queryClient.setQueryData(['files', 'roots'], { roots: options.roots });
  }
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider runtime={runtime}>
            <SidebarProvider>
              <FilesTab nodeOffline={options.nodeOffline} />
            </SidebarProvider>
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('FilesTab 的根目录过滤', () => {
  test('本机设备的启用目录默认显示', () => {
    const html = renderFilesTab({ roots: [LOCAL_ROOT] });
    expect(html).toContain('/srv/local');
    expect(html).not.toContain('没有可访问的目录');
  });

  test('未连接的 SSH 设备的目录不显示', () => {
    const html = renderFilesTab({ roots: [LOCAL_ROOT, SSH_ROOT] });
    expect(html).toContain('/srv/local');
    expect(html).not.toContain('/srv/ssh');
  });

  test('禁用的目录不显示', () => {
    const html = renderFilesTab({ roots: [{ ...LOCAL_ROOT, enabled: false }] });
    expect(html).not.toContain('/srv/local');
    expect(html).toContain('没有可访问的目录');
  });
});

describe('FilesTab 在 node 离线时', () => {
  test('只留一行「节点离线」，不显示陈旧目录，也没有错误/重试入口', () => {
    const html = renderFilesTab({ roots: [LOCAL_ROOT], nodeOffline: true });
    expect(html).toContain('data-testid="files-node-offline"');
    expect(html).toContain('节点离线');
    expect(html).not.toContain('/srv/local');
    expect(html).not.toContain('data-testid="files-roots-error"');
    expect(html).not.toContain('data-testid="files-refresh"');
  });

  test('node 在线时不出现离线提示', () => {
    expect(renderFilesTab({ roots: [LOCAL_ROOT] })).not.toContain(
      'data-testid="files-node-offline"'
    );
  });
});
