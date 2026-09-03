// 文件树的行结构：整棵树只挂一个共享 ContextMenu，行退化成不带菜单/回调的按钮。
// bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML（与 files-tab.test.tsx 同法）。

import { describe, expect, test } from 'bun:test';
import type { FileEntryDto, FileRootDto } from '@tmex/shared';
import { installWindowStorage } from '@tmex/stores/test-utils';

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
const { FilesTab } = await import('./files-tab');
const { FILE_LEAF_PATH_ATTR, FILE_LIST_DIR_ATTR, FILE_LIST_ROOT_ATTR } = await import(
  './file-leaf-target'
);

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const ROOT: FileRootDto = {
  id: 'r-local',
  deviceId: 'd-local',
  deviceName: '书房',
  deviceType: 'local',
  path: '/srv/local',
  name: 'local',
  enabled: true,
  sortOrder: 0,
};

let storageSeq = 0;

function fileEntry(index: number): FileEntryDto {
  return {
    name: `f${index}.txt`,
    path: `${ROOT.path}/f${index}.txt`,
    type: 'file',
    category: 'text',
    size: 1,
    modifiedAt: null,
    isSymlink: false,
  };
}

/** 展开态在静态渲染下无法经 localStorage 预置，这里把 fileTree 面换成一个已展开的桩。 */
function renderExpandedRoot(entries: FileEntryDto[]): string {
  const runtime = createAppRuntime({ storagePrefix: `files-roots-test-${storageSeq++}:` });
  const fileTreeState = {
    expanded: { [`${ROOT.id}\n${ROOT.path}`]: true },
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
  queryClient.setQueryData(['files', 'roots'], { roots: [ROOT] });
  queryClient.setQueryData(['files', 'list', ROOT.id, ROOT.path], {
    path: ROOT.path,
    entries,
    truncated: false,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
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

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('文件树的共享右键菜单', () => {
  test('500 行只有一个树级 Trigger，行数再多也不涨（目录行各自那一个除外）', () => {
    const small = renderExpandedRoot(Array.from({ length: 10 }, (_, i) => fileEntry(i)));
    const large = renderExpandedRoot(Array.from({ length: 500 }, (_, i) => fileEntry(i)));

    expect(count(large, 'data-testid="file-item-')).toBe(500);
    // 一个树级共享 Trigger + 展开着的那一个目录行自己的 Trigger
    expect(count(small, 'data-slot="context-menu-trigger"')).toBe(2);
    expect(count(large, 'data-slot="context-menu-trigger"')).toBe(2);
  });

  test('文件行不再兼任 Trigger，也不再各带一份菜单内容', () => {
    const html = renderExpandedRoot(Array.from({ length: 500 }, (_, i) => fileEntry(i)));
    const rows = html.match(/<button[^>]*data-testid="file-item-[^>]*>/g) ?? [];
    expect(rows.length).toBe(500);
    for (const row of rows) {
      expect(row).not.toContain('data-slot="context-menu-trigger"');
      expect(row).toContain(`${FILE_LEAF_PATH_ATTR}="`);
      expect(row).toContain('draggable="true"');
    }
    expect(count(html, 'data-testid="file-download-')).toBe(0);
  });

  test('列表容器带上根 id 与目录路径，供共享菜单反查命中行', () => {
    const html = renderExpandedRoot([fileEntry(0)]);
    expect(html).toContain(`${FILE_LIST_ROOT_ATTR}="${ROOT.id}"`);
    expect(html).toContain(`${FILE_LIST_DIR_ATTR}="${ROOT.path}"`);
    expect(html).toContain(`${FILE_LEAF_PATH_ATTR}="${ROOT.path}/f0.txt"`);
  });

  test('文件行缩进与提到菜单之前一致（比同级状态行多一级）', () => {
    const html = renderExpandedRoot([fileEntry(0)]);
    // depth=1 的文件行：1*12 + 4 + 18 = 34
    expect(html).toContain('padding-left:34px');
  });
});
