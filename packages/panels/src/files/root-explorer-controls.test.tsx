// 根行尾部的「打开 / 关闭」按钮与 SSH 标记：bun test 无 DOM，用 react-dom/server 静态渲染断言 HTML。
// 静态渲染下 zustand 读的是建店时的 state，所以「已在文件管理器中打开」用一个桩 store 来表达
// （与 files-tab.test.tsx 里替换 fileTree 的做法相同）。

import { describe, expect, test } from 'bun:test';
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
const { RuntimeProvider } = await import('@vibeterm/stores/react');
const i18next = (await import('i18next')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nextProvider } = await import('react-i18next');
const { MemoryRouter } = await import('react-router');
const { SidebarProvider } = await import('@vibeterm/ui/sidebar');
const { RootExplorerControls } = await import('./root-explorer-controls');

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
}

function renderControls(root: FileRootDto, openTabs: OpenTab[] = []): string {
  const runtime = createAppRuntime({ storagePrefix: `root-explorer-test-${storageSeq++}:` });
  const tabs = Object.fromEntries(
    openTabs.map((tab, index) => [
      `t${index}`,
      {
        id: `t${index}`,
        nodeId: tab.nodeId ?? runtime.nodeId,
        rootId: tab.rootId,
        history: ['/srv'],
        index: 0,
      },
    ])
  );
  const explorerState = { ...runtime.stores.explorer.getState(), tabs };
  const explorer = Object.assign(
    <T,>(selector: (state: typeof explorerState) => T): T => selector(explorerState),
    { getState: () => explorerState }
  );
  const stubbedRuntime = {
    ...runtime,
    stores: { ...runtime.stores, explorer },
  } as unknown as typeof runtime;

  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <I18nextProvider i18n={i18n}>
        <RuntimeProvider runtime={stubbedRuntime}>
          <SidebarProvider>
            <RootExplorerControls root={root} />
          </SidebarProvider>
        </RuntimeProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  runtime.dispose();
  return html;
}

function explorerButton(html: string, rootId: string): string {
  const match = html.match(
    new RegExp(`<button[^>]*data-testid="file-root-explorer-${rootId}"[^>]*>([^<]*)</button>`)
  );
  if (!match) throw new Error('explorer button not rendered');
  return match[0];
}

describe('RootExplorerControls 的打开 / 关闭按钮', () => {
  test('文件管理器里没有该根目录的标签页：显示「打开」，未按下', () => {
    const button = explorerButton(renderControls(LOCAL_ROOT), LOCAL_ROOT.id);
    expect(button).toContain('>打开</button>');
    expect(button).toContain('aria-pressed="false"');
    expect(button).toContain('type="button"');
    expect(button).not.toContain('text-primary');
  });

  test('已有该根目录的标签页：显示「关闭」并标记为按下', () => {
    const html = renderControls(LOCAL_ROOT, [{ rootId: LOCAL_ROOT.id }]);
    const button = explorerButton(html, LOCAL_ROOT.id);
    expect(button).toContain('>关闭</button>');
    expect(button).toContain('aria-pressed="true"');
    expect(button).toContain('text-primary');
  });

  test('别的根目录、或别的 node 上同 id 的根目录开着不算', () => {
    const otherRoot = renderControls(LOCAL_ROOT, [{ rootId: SSH_ROOT.id }]);
    expect(explorerButton(otherRoot, LOCAL_ROOT.id)).toContain('aria-pressed="false"');

    const otherNode = renderControls(LOCAL_ROOT, [
      { nodeId: 'ffffffffffffffffffffffffffffffff', rootId: LOCAL_ROOT.id },
    ]);
    expect(explorerButton(otherNode, LOCAL_ROOT.id)).toContain('>打开</button>');
  });
});

describe('RootExplorerControls 的 SSH 标记', () => {
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
