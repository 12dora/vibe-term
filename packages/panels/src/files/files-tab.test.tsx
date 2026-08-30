// 文件侧栏的外壳与过滤：bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML。
// 静态渲染下 zustand 走 `getInitialState`（可见性/连接表都是默认值），所以这里覆盖
// 「默认显示」「设备没连上就不显示」「node 离线只留一行提示」这三条；
// 「关掉开关就消失」由 root-visibility 的单测覆盖。

import { describe, expect, test } from 'bun:test';
import type { FileEntryDto, FileRootDto } from '@tmex/shared';
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
const { createAppRuntime, fileRoute, hostAppPath } = await import('@tmex/stores');
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

function fileEntry(index: number): FileEntryDto {
  return {
    name: `f${index}.txt`,
    path: `${LOCAL_ROOT.path}/f${index}.txt`,
    type: 'file',
    category: 'text',
    size: 1,
    modifiedAt: null,
    isSymlink: false,
  };
}

/**
 * 静态渲染下 zustand 读的是**建店时**的 state（persist 的 hydrate 之后才落到 getState），
 * 展开态无法经 localStorage 预置，于是把 fileTree 面换成一个已展开的桩；
 * 目录列表直接喂进 query 缓存，这样能在无 DOM 环境里数出真正挂载了多少行。
 */
function renderExpandedRoot(entries: FileEntryDto[], selectedPath?: string): string {
  const runtime = createAppRuntime({ storagePrefix: `files-tab-test-${storageSeq++}:` });
  const fileTreeState = {
    expanded: { [`${LOCAL_ROOT.id}\n${LOCAL_ROOT.path}`]: true },
    toggle: () => undefined,
    expand: () => undefined,
    collapse: () => undefined,
    pruneRoot: () => undefined,
    pruneStaleRoots: () => undefined,
  };
  const fileTree = Object.assign(
    <T,>(selector: (state: typeof fileTreeState) => T): T => selector(fileTreeState),
    { getState: () => fileTreeState }
  );
  const expandedRuntime = {
    ...runtime,
    stores: { ...runtime.stores, fileTree },
  } as unknown as typeof runtime;

  const queryClient = new QueryClient();
  queryClient.setQueryData(['files', 'roots'], { roots: [LOCAL_ROOT] });
  queryClient.setQueryData(['files', 'list', LOCAL_ROOT.id, LOCAL_ROOT.path], {
    path: LOCAL_ROOT.path,
    entries,
    truncated: false,
  });
  const route = selectedPath
    ? hostAppPath(runtime.host, fileRoute(LOCAL_ROOT.id, selectedPath))
    : '/';
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={[route]}>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider runtime={expandedRuntime}>
            <SidebarProvider>
              <FilesTab />
            </SidebarProvider>
          </RuntimeProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

function countRows(html: string): number {
  return html.match(/data-testid="file-item-/g)?.length ?? 0;
}

describe('FilesTab 的单目录行数上限', () => {
  test('2000 条只挂 500 行，其余收在「显示其余」按钮后', () => {
    const html = renderExpandedRoot(Array.from({ length: 2000 }, (_, i) => fileEntry(i)));
    expect(countRows(html)).toBe(500);
    expect(html).toContain(`data-testid="file-show-more-${LOCAL_ROOT.id}-${LOCAL_ROOT.path}"`);
    expect(html).toContain('显示其余 1500 项');
  });

  test('路由选中的文件在上限之外时上限撑到它，行仍然挂载', () => {
    const entries = Array.from({ length: 2000 }, (_, i) => fileEntry(i));
    const html = renderExpandedRoot(entries, entries[999].path);
    expect(html).toContain(`data-testid="file-item-${LOCAL_ROOT.id}-${entries[999].path}"`);
    expect(countRows(html)).toBe(1000);
    expect(html).toContain('显示其余 1000 项');
  });

  test('未超过上限时全量渲染，不出现「显示其余」', () => {
    const html = renderExpandedRoot(Array.from({ length: 12 }, (_, i) => fileEntry(i)));
    expect(countRows(html)).toBe(12);
    expect(html).not.toContain('data-testid="file-show-more-');
  });
});
