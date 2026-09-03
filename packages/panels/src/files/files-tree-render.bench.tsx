// 文件树 SSR 渲染基准：500 行单目录，`renderToStaticMarkup` 20 次取均值。
// 与 EX1 §1.12 的测法一致（纯 button 1.74ms / +useTranslation 6.85ms / +ContextMenu 29.18ms）。
//
//   bun packages/panels/src/files/files-tree-render.bench.tsx

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

let seq = 0;

function renderOnce(entries: FileEntryDto[]): string {
  const runtime = createAppRuntime({ storagePrefix: `files-bench-${seq++}:` });
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

// 提菜单之前的实测（同机同法）：500 行 mean=62.36ms p50=61.49ms、Trigger 501 个；
// 50 行 mean=6.75ms。阈值取得很宽，只用来兜住「每行又挂回一个 ContextMenu」这类回归。
const BUDGET_MS: Record<string, number> = { '500 rows': 40, '50 rows': 5 };

function bench(label: string, rows: number, iterations = 20): void {
  const entries = Array.from({ length: rows }, (_, i) => fileEntry(i));
  for (let i = 0; i < 5; i++) renderOnce(entries);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const html = renderOnce(entries);
    samples.push(performance.now() - start);
    if ((html.match(/data-testid="file-item-/g) ?? []).length !== Math.min(rows, 500)) {
      throw new Error('unexpected row count');
    }
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const triggers = (renderOnce(entries).match(/data-slot="context-menu-trigger"/g) ?? []).length;
  console.log(
    `${label.padEnd(22)} mean=${mean.toFixed(2)}ms p50=${samples[samples.length >> 1].toFixed(2)}ms  context-menu triggers=${triggers}`
  );
  // 树级共享菜单 1 个 + 展开着的那一个目录行自己的 1 个；行数变了这个数字也不该变
  if (triggers !== 2) throw new Error(`expected 2 context-menu triggers, got ${triggers}`);
  const budget = BUDGET_MS[label];
  if (budget !== undefined && mean > budget) {
    throw new Error(`${label}: mean ${mean.toFixed(2)}ms exceeds budget ${budget}ms`);
  }
}

bench('500 rows', 500);
bench('50 rows', 50);
process.exit(0);
