// 多 node 文件侧栏的分节：bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML。
// 覆盖三种形态（在线已登录 / 在线未登录 / 离线）与分节头上的 node 名、拖拽手柄。

import { describe, expect, test } from 'bun:test';
import type { FileRootDto } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';
import type { FilesNodeInfo } from './files-node-section';

installWindowStorage();

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
const { FilesNodeSection } = await import('./files-node-section');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const REMOTE_ROOT: FileRootDto = {
  id: 'r-remote',
  deviceId: 'd-remote-local',
  deviceName: '应用服务器',
  deviceType: 'local',
  path: '/srv/app',
  name: 'app',
  enabled: true,
  sortOrder: 0,
};

const ROOT_B: FileRootDto = {
  ...REMOTE_ROOT,
  id: 'r-b',
  deviceId: 'd-b-local',
  path: '/srv/node-b',
  name: 'node-b',
};

const REMOTE_NODE: FilesNodeInfo = {
  id: 'node-app',
  runtimeNodeId: 'node-app',
  name: 'demo-app',
  online: true,
  loggedIn: true,
  isSelf: false,
};

let storageSeq = 0;

function renderSection(node: FilesNodeInfo, roots: FileRootDto[] = []): string {
  const runtime = createAppRuntime({ storagePrefix: `files-node-section-${storageSeq++}:` });
  const queryClient = new QueryClient();
  queryClient.setQueryData(['files', 'roots'], { roots });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider runtime={runtime}>
            <SidebarProvider>
              <FilesNodeSection
                node={node}
                renderLogin={(target) => <span>登录 {target.name}</span>}
              />
            </SidebarProvider>
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

describe('FilesNodeSection 的分节头', () => {
  test('在线已登录时显示 node 名与该 node 的目录', () => {
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT]);
    expect(html).toContain('data-testid="files-node-section-node-app"');
    expect(html).toContain('demo-app');
    expect(html).toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('离线只留一行提示，不渲染目录', () => {
    const html = renderSection({ ...REMOTE_NODE, online: false }, [REMOTE_ROOT]);
    expect(html).toContain('data-testid="files-node-offline-node-app"');
    expect(html).toContain('节点离线');
    expect(html).not.toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('在线未登录只留登录入口，不渲染目录', () => {
    const html = renderSection({ ...REMOTE_NODE, loggedIn: false }, [REMOTE_ROOT]);
    expect(html).toContain('data-testid="files-node-login-node-app"');
    expect(html).toContain('登录后显示文件');
    expect(html).toContain('登录 demo-app');
    expect(html).not.toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('根行带拖拽手柄，分节头带折叠开关', () => {
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT]);
    expect(html).toContain('data-testid="files-node-toggle-node-app"');
    expect(html).toContain('aria-label="拖动以调整目录顺序"');
  });
});

function countingRuntime(): { runtime: ReturnType<typeof createAppRuntime>; calls: () => number } {
  const base = createAppRuntime({ storagePrefix: `files-node-section-${storageSeq++}:` });
  let calls = 0;
  const runtime = {
    ...base,
    apiClient: {
      ...base.apiClient,
      fetch: (...args: unknown[]) => {
        calls += 1;
        return (base.apiClient.fetch as (...a: unknown[]) => Promise<Response>)(...args);
      },
    },
    dispose: base.dispose,
  } as unknown as typeof base;
  return { runtime, calls: () => calls };
}

describe('FilesNodeSection 的按 node 隔离', () => {
  test('两个分节各用各的 QueryClient：A 的目录不会出现在 B 里，未登录的分节一个请求都不发', () => {
    const a = countingRuntime();
    const b = countingRuntime();
    const offline = countingRuntime();
    const clientA = new QueryClient();
    const clientB = new QueryClient();
    const clientOffline = new QueryClient();
    clientA.setQueryData(['files', 'roots'], { roots: [REMOTE_ROOT] });
    clientB.setQueryData(['files', 'roots'], { roots: [ROOT_B] });

    const section = (
      node: FilesNodeInfo,
      client: InstanceType<typeof QueryClient>,
      runtime: ReturnType<typeof createAppRuntime>
    ) => (
      <QueryClientProvider client={client}>
        <RuntimeProvider runtime={runtime}>
          <FilesNodeSection node={node} renderLogin={() => <span>登录</span>} />
        </RuntimeProvider>
      </QueryClientProvider>
    );

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <SidebarProvider>
            {section(REMOTE_NODE, clientA, a.runtime)}
            {section(
              { ...REMOTE_NODE, id: 'node-b', runtimeNodeId: 'node-b', name: 'node-b' },
              clientB,
              b.runtime
            )}
            {section(
              { ...REMOTE_NODE, id: 'node-c', runtimeNodeId: 'node-c', loggedIn: false },
              clientOffline,
              offline.runtime
            )}
          </SidebarProvider>
        </I18nextProvider>
      </MemoryRouter>
    );
    a.runtime.dispose();
    b.runtime.dispose();
    offline.runtime.dispose();

    const startB = html.indexOf('data-testid="files-node-section-node-b"');
    const startC = html.indexOf('data-testid="files-node-section-node-c"');
    expect(startB).toBeGreaterThan(0);
    const htmlA = html.slice(0, startB);
    const htmlB = html.slice(startB, startC);

    expect(htmlA).toContain('/srv/app');
    expect(htmlA).not.toContain('/srv/node-b');
    expect(htmlB).toContain('/srv/node-b');
    expect(htmlB).not.toContain('data-testid="file-dir-r-remote-/srv/app"');

    // 缓存互不串：各自只认得自己那份 roots
    expect(clientA.getQueryData<{ roots: FileRootDto[] }>(['files', 'roots'])?.roots).toHaveLength(
      1
    );
    expect(clientB.getQueryData<{ roots: FileRootDto[] }>(['files', 'roots'])?.roots[0].id).toBe(
      'r-b'
    );

    // 未登录的分节：既没有挂上 roots 查询，也没有打过任何请求
    expect(clientOffline.getQueryCache().find({ queryKey: ['files', 'roots'] })).toBeUndefined();
    expect(offline.calls()).toBe(0);
    // 对照：已登录的分节确实挂上了 roots 查询
    expect(clientA.getQueryCache().find({ queryKey: ['files', 'roots'] })).toBeDefined();
  });
});
