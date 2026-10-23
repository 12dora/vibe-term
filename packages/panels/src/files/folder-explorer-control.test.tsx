// 文件夹行（根行 + 子目录行）尾部的「打开 / 关闭」按钮与根行的 SSH 标记：bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML。
// 文件管理器的 store 是全局单例（不挂在 runtime 上）：每个用例换一份独立存储的实例，用 openLocation
// 预置标签页。静态渲染下 zustand 的 hook 读的是建店时的 state，所以注入的是一层读 getState() 的壳。

import { afterEach, describe, expect, test } from 'bun:test';
import type { FileRootDto } from '@vibeterm/shared';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

(globalThis.window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: true,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

const { I18N_RESOURCES } = await import('@vibeterm/shared');
const { createAppRuntime } = await import('@vibeterm/stores');
const { createExplorerStore, getExplorerStore, resetExplorerStoreForTest } = await import(
  '@vibeterm/stores/explorer'
);
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const i18next = (await import('i18next')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nextProvider } = await import('react-i18next');
const { MemoryRouter } = await import('react-router');
const { SidebarProvider } = await import('@vibeterm/ui/sidebar');
const { FolderExplorerControl } = await import('./folder-explorer-control');

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

interface OpenTab {
  nodeId?: string;
  rootId: string;
  /** 标签页正停在的目录，缺省为根路径。 */
  path?: string;
}

interface RenderOptions {
  /** 这一行代表的目录，缺省即根路径。 */
  path?: string;
  /** 文件夹显示名，缺省取根目录名。 */
  name?: string;
  isRoot?: boolean;
}

function renderControls(
  root: FileRootDto,
  openTabs: OpenTab[] = [],
  options: RenderOptions = {}
): string {
  const storagePrefix = `root-explorer-test-${storageSeq++}:`;
  const runtime = createAppRuntime({ storagePrefix });
  const real = createExplorerStore({ storagePrefix });
  type ExplorerState = ReturnType<typeof real.getState>;
  const live = Object.assign(
    <T,>(selector: (state: ExplorerState) => T): T => selector(real.getState()),
    { getState: real.getState, setState: real.setState, subscribe: real.subscribe }
  );
  resetExplorerStoreForTest(live as unknown as typeof real);
  for (const tab of openTabs) {
    getExplorerStore()
      .getState()
      .openLocation(
        { nodeId: tab.nodeId ?? runtime.nodeId, rootId: tab.rootId, path: tab.path ?? root.path },
        { newTab: true }
      );
  }
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <I18nextProvider i18n={i18n}>
        <RuntimeProvider runtime={runtime}>
          <SidebarProvider>
            <FolderExplorerControl
              root={root}
              path={options.path ?? root.path}
              name={options.name ?? root.name}
              isRoot={options.isRoot ?? true}
            />
          </SidebarProvider>
        </RuntimeProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

afterEach(() => {
  resetExplorerStoreForTest();
});

function buttonByTestId(html: string, testId: string): string {
  const escaped = testId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(
    new RegExp(`<button[^>]*data-testid="${escaped}"[^>]*>([^<]*)</button>`)
  );
  if (!match) throw new Error('explorer button not rendered');
  return match[0];
}

function explorerButton(html: string, rootId: string): string {
  return buttonByTestId(html, `file-root-explorer-${rootId}`);
}

describe('根行的打开 / 关闭按钮', () => {
  test('文件管理器里没有标签页停在根目录：显示「打开」，根行常显', () => {
    const button = explorerButton(renderControls(LOCAL_ROOT), LOCAL_ROOT.id);
    expect(button).toContain('>打开</button>');
    expect(button).toContain('data-state="closed"');
    expect(button).toContain('type="button"');
    expect(button).not.toContain('text-primary');
    expect(button).not.toContain('opacity-0');
  });

  test('已有标签页正停在根目录：显示「关闭」，状态只由文案表达（不再叠加 aria-pressed）', () => {
    const html = renderControls(LOCAL_ROOT, [{ rootId: LOCAL_ROOT.id }]);
    const button = explorerButton(html, LOCAL_ROOT.id);
    expect(button).toContain('>关闭</button>');
    expect(button).toContain('data-state="open"');
    expect(button).not.toContain('aria-pressed');
    expect(button).toContain('text-primary');
  });

  test('标签页进了子目录就不再算根目录开着', () => {
    const html = renderControls(LOCAL_ROOT, [{ rootId: LOCAL_ROOT.id, path: '/srv/local/docs' }]);
    expect(explorerButton(html, LOCAL_ROOT.id)).toContain('>打开</button>');
  });

  test('别的根目录、或别的 node 上同 id 的根目录开着不算', () => {
    const otherRoot = renderControls(LOCAL_ROOT, [{ rootId: SSH_ROOT.id }]);
    expect(explorerButton(otherRoot, LOCAL_ROOT.id)).toContain('data-state="closed"');

    const otherNode = renderControls(LOCAL_ROOT, [
      { nodeId: 'ffffffffffffffffffffffffffffffff', rootId: LOCAL_ROOT.id },
    ]);
    expect(explorerButton(otherNode, LOCAL_ROOT.id)).toContain('>打开</button>');
  });
});

describe('子目录行的打开 / 关闭按钮', () => {
  const DOCS = '/srv/local/docs';
  const docsId = `file-dir-explorer-${LOCAL_ROOT.id}-${DOCS}`;
  const asDir = { path: DOCS, name: 'docs', isRoot: false };

  test('没有标签页停在该目录：「打开」，平时隐去、悬停或聚焦行时现身、触屏常显', () => {
    const button = buttonByTestId(renderControls(LOCAL_ROOT, [], asDir), docsId);
    expect(button).toContain('>打开</button>');
    expect(button).toContain('data-state="closed"');
    expect(button).toContain('opacity-0');
    expect(button).toContain('group-hover/dir-row:opacity-100');
    expect(button).toContain('group-focus-within/dir-row:opacity-100');
    expect(button).toContain('any-pointer:coarse');
  });

  test('标签页正停在该目录：「关闭」，恒显', () => {
    const html = renderControls(LOCAL_ROOT, [{ rootId: LOCAL_ROOT.id, path: DOCS }], asDir);
    const button = buttonByTestId(html, docsId);
    expect(button).toContain('>关闭</button>');
    expect(button).toContain('data-state="open"');
    expect(button).toContain('text-primary');
    expect(button).not.toContain('opacity-0');
  });

  test('只认精确路径：停在根目录或上级 / 下级都不算该目录开着', () => {
    for (const path of ['/srv/local', '/srv/local/docs/sub']) {
      const html = renderControls(LOCAL_ROOT, [{ rootId: LOCAL_ROOT.id, path }], asDir);
      expect(buttonByTestId(html, docsId)).toContain('>打开</button>');
    }
  });

  test('同一目录在别的根目录或别的 node 上开着不算', () => {
    const otherRoot = renderControls(LOCAL_ROOT, [{ rootId: SSH_ROOT.id, path: DOCS }], asDir);
    expect(buttonByTestId(otherRoot, docsId)).toContain('>打开</button>');
    const otherNode = renderControls(
      LOCAL_ROOT,
      [{ nodeId: 'ffffffffffffffffffffffffffffffff', rootId: LOCAL_ROOT.id, path: DOCS }],
      asDir
    );
    expect(buttonByTestId(otherNode, docsId)).toContain('>打开</button>');
  });

  test('读屏标签带上文件夹名，可见文字仍是打开 / 关闭', () => {
    const closed = buttonByTestId(renderControls(LOCAL_ROOT, [], asDir), docsId);
    expect(closed).toContain('aria-label="在文件管理器中打开 docs"');
    const open = renderControls(LOCAL_ROOT, [{ rootId: LOCAL_ROOT.id, path: DOCS }], asDir);
    expect(buttonByTestId(open, docsId)).toContain('aria-label="在文件管理器中关闭 docs"');
    const root = explorerButton(renderControls(LOCAL_ROOT), LOCAL_ROOT.id);
    expect(root).toContain('aria-label="在文件管理器中打开 local"');
  });

  test('子目录行不带根行的 testid 与 SSH 小地球', () => {
    const html = renderControls(SSH_ROOT, [], { path: '/srv/ssh/x', isRoot: false });
    expect(html).not.toContain('data-testid="file-root-explorer-');
    expect(html).not.toContain('data-testid="file-root-remote-');
  });
});

describe('根行的 SSH 标记', () => {
  test('SSH 根目录在按钮左侧带一个小地球，title 是设备名', () => {
    const html = renderControls(SSH_ROOT);
    const marker = html.match(/<span[^>]*data-testid="file-root-remote-r-ssh"[^>]*>/)?.[0];
    expect(marker).toBeDefined();
    expect(marker).toContain('title="机房"');
    expect(html.indexOf('data-testid="file-root-remote-r-ssh"')).toBeLessThan(
      html.indexOf('data-testid="file-root-explorer-r-ssh"')
    );
    expect(html).toContain('h-3 w-3');
    // 设备名只在 title / aria-label 里，不再作为行内文字出现
    expect(html).not.toContain('>机房<');
  });

  test('没有设备名时退回设备 id', () => {
    const html = renderControls({ ...SSH_ROOT, deviceName: null });
    expect(html).toContain('title="d-ssh"');
  });

  test('本机根目录不带标记', () => {
    const html = renderControls(LOCAL_ROOT);
    expect(html).not.toContain('data-testid="file-root-remote-');
    expect(html).not.toContain('书房');
  });
});
