// 多 node 文件侧栏的分节：bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML。
// 覆盖三种形态（在线已登录 / 在线未登录 / 离线）与分节头上的 node 名、拖拽手柄。

import { describe, expect, test } from 'bun:test';
import type { FileRootDto } from '@vibeterm/shared';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { FilesNodeInfo } from './files-node-section';

installWindowStorage();

(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { I18N_RESOURCES } = await import('@vibeterm/shared');
const { createAppRuntime } = await import('@vibeterm/stores');
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const i18next = (await import('i18next')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nextProvider } = await import('react-i18next');
const { MemoryRouter } = await import('react-router');
const { SidebarProvider } = await import('@vibeterm/ui/sidebar');
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
  name: 'jiefa-app',
  online: true,
  loggedIn: true,
  isSelf: false,
};

let storageSeq = 0;

/** 该远端 node 在「管理设备」里显式打开过「文件」的设备 */
const REMOTE_OPT_IN = { 'node-app:d-remote-local': true };

/**
 * 静态渲染下 zustand 只读 `getInitialState`（hook 上的该方法与内部 api 不是同一引用，替换无效），
 * 只能改写它返回的初始 state 对象，才能表达「用户在设备卡片上动过文件开关」。
 */
function seedFilesVisibility(
  runtime: ReturnType<typeof createAppRuntime>,
  visibility: Record<string, boolean>
): void {
  Object.assign(runtime.stores.ui.getInitialState(), { sidebarFilesVisibility: visibility });
}

/**
 * `runtimeNodeId` 决定文件可见性的缺省：`self` 的设备配了目录就显示，远端 node 的设备默认隐藏。
 * 静态渲染下 zustand 只认 `getInitialState`（改 store / 写持久化存储都不生效），
 * 所以「开着开关的远端 node」只能靠 runtime 跑在 `self` 下来表达。
 */
function renderSection(
  node: FilesNodeInfo,
  roots: FileRootDto[] = [],
  options: {
    runtimeNodeId?: string;
    rootsLoaded?: boolean;
    expanded?: boolean;
    filesVisibility?: Record<string, boolean>;
  } = {}
): string {
  const runtime = createAppRuntime({
    storagePrefix: `files-node-section-${storageSeq++}:`,
    nodeId: options.runtimeNodeId,
  });
  if (options.filesVisibility) seedFilesVisibility(runtime, options.filesVisibility);
  const queryClient = new QueryClient();
  if (options.rootsLoaded !== false) queryClient.setQueryData(['files', 'roots'], { roots });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RuntimeProvider runtime={runtime}>
            <SidebarProvider>
              <FilesNodeSection
                node={node}
                expanded={options.expanded}
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
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT], { filesVisibility: REMOTE_OPT_IN });
    expect(html).toContain('data-testid="files-node-section-node-app"');
    expect(html).toContain('jiefa-app');
    expect(html).toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('离线只留一行提示，不渲染目录', () => {
    const html = renderSection({ ...REMOTE_NODE, online: false }, [REMOTE_ROOT], {
      filesVisibility: REMOTE_OPT_IN,
    });
    expect(html).toContain('data-testid="files-node-offline-node-app"');
    expect(html).toContain('节点离线');
    expect(html).not.toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('在线未登录只留登录入口，不渲染目录', () => {
    const html = renderSection({ ...REMOTE_NODE, loggedIn: false }, [REMOTE_ROOT], {
      filesVisibility: REMOTE_OPT_IN,
    });
    expect(html).toContain('data-testid="files-node-login-node-app"');
    expect(html).toContain('登录后显示文件');
    expect(html).toContain('登录 jiefa-app');
    expect(html).not.toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('远端 node 的设备缺省隐藏：一个可见目录都没有时整节不渲染', () => {
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT], { runtimeNodeId: 'node-app' });
    expect(html).not.toContain('data-testid="files-node-section-node-app"');
    expect(html).not.toContain('jiefa-app');
  });

  test('一个目录都没配过时整节仍不渲染：提示由外壳统一出一条', () => {
    const html = renderSection(REMOTE_NODE, []);
    expect(html).not.toContain('data-testid="files-node-section-node-app"');
    expect(html).not.toContain('data-testid="files-no-roots-hint"');
  });

  test('目录列表还没回来时不渲染分节头，避免头闪一下又消失', () => {
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT], { rootsLoaded: false });
    expect(html).not.toContain('data-testid="files-node-section-node-app"');
  });

  test('离线 / 未登录的分节在该 node 有设备打开「文件」时照常渲染（承载提示与登录入口）', () => {
    const offline = renderSection({ ...REMOTE_NODE, online: false }, [], {
      runtimeNodeId: 'node-app',
      filesVisibility: REMOTE_OPT_IN,
    });
    expect(offline).toContain('data-testid="files-node-section-node-app"');
    const signedOut = renderSection({ ...REMOTE_NODE, loggedIn: false }, [], {
      runtimeNodeId: 'node-app',
      filesVisibility: REMOTE_OPT_IN,
    });
    expect(signedOut).toContain('data-testid="files-node-section-node-app"');
  });

  /**
   * 回归：远端 node 的设备全都没打开「文件」（缺省即关，或在设备卡片上显式关掉）时，
   * 拿不到目录列表的折叠 / 离线 / 未登录分节也不能出头——否则头先出现，一点开挂上运行时
   * 按目录过滤后整节变空，看上去就是「点一下就消失」。
   */
  test.each([
    ['折叠', { expanded: false }],
    ['离线', { online: false }],
    ['未登录', { loggedIn: false }],
  ] as const)('远端 node 没有设备打开「文件」时%s分节也不出头', (_label, variant) => {
    const { expanded, ...nodePatch } = { expanded: undefined, ...variant };
    const node = { ...REMOTE_NODE, ...nodePatch };
    const maps: Record<string, boolean>[] = [{}, { 'node-app:d-remote-local': false }];
    for (const filesVisibility of maps) {
      const html = renderSection(node, [REMOTE_ROOT], { expanded, filesVisibility });
      expect(html).not.toContain('data-testid="files-node-section-node-app"');
      expect(html).not.toContain('jiefa-app');
    }
  });

  test('远端 node 在线已登录但没有设备打开「文件」：不出头，也不挂 roots 查询', () => {
    const runtime = createAppRuntime({ storagePrefix: `files-node-section-${storageSeq++}:` });
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <RuntimeProvider runtime={runtime}>
              <SidebarProvider>
                <FilesNodeSection node={REMOTE_NODE} expanded />
              </SidebarProvider>
            </RuntimeProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </MemoryRouter>
    );
    runtime.dispose();

    expect(html).not.toContain('data-testid="files-node-section-node-app"');
    expect(queryClient.getQueryCache().find({ queryKey: ['files', 'roots'] })).toBeUndefined();
  });

  test('别的 node 打开的开关不会让本 node 的折叠分节出头', () => {
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT], {
      expanded: false,
      filesVisibility: { 'node-other:d-remote-local': true, 'self:d-remote-local': true },
    });
    expect(html).not.toContain('data-testid="files-node-section-node-app"');
  });

  const SELF_NODE: FilesNodeInfo = {
    id: 'entry-node',
    runtimeNodeId: 'self',
    name: '本机',
    online: true,
    loggedIn: true,
    isSelf: true,
  };

  test('本机折叠时按目录列表决定：设备的「文件」全关就不出头', () => {
    const html = renderSection(SELF_NODE, [REMOTE_ROOT], {
      expanded: false,
      filesVisibility: { 'self:d-remote-local': false },
    });
    expect(html).not.toContain('data-testid="files-node-section-self"');
  });

  test('本机折叠且有可见目录时只出收起的分节头，不渲染目录', () => {
    const html = renderSection(SELF_NODE, [REMOTE_ROOT], { expanded: false });
    expect(html).toContain('data-testid="files-node-section-self"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="file-dir-r-remote-/srv/app"');
  });

  test('根行带拖拽手柄，分节头带折叠开关', () => {
    const html = renderSection(REMOTE_NODE, [REMOTE_ROOT], { filesVisibility: REMOTE_OPT_IN });
    expect(html).toContain('data-testid="files-node-toggle-node-app"');
    expect(html).toContain('aria-label="拖动以调整目录顺序"');
  });

  /**
   * 受控折叠：宿主收起分节时会把该 node 的运行时一起摘掉，分节里一条查询都不能挂
   * ——上下文里只剩 entry 的 QueryClient，挂上去读到的会是别人的目录。
   */
  test('受控折叠时只留分节头，不挂 roots 查询', () => {
    const runtime = createAppRuntime({ storagePrefix: `files-node-section-${storageSeq++}:` });
    seedFilesVisibility(runtime, REMOTE_OPT_IN);
    const queryClient = new QueryClient();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <RuntimeProvider runtime={runtime}>
              <SidebarProvider>
                <FilesNodeSection node={REMOTE_NODE} expanded={false} />
              </SidebarProvider>
            </RuntimeProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </MemoryRouter>
    );
    runtime.dispose();

    expect(html).toContain('data-testid="files-node-section-node-app"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="file-dir-r-remote-/srv/app"');
    expect(queryClient.getQueryCache().find({ queryKey: ['files', 'roots'] })).toBeUndefined();
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
    seedFilesVisibility(a.runtime, REMOTE_OPT_IN);
    seedFilesVisibility(b.runtime, { 'node-b:d-b-local': true });
    seedFilesVisibility(offline.runtime, { 'node-c:d-c-local': true });
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
