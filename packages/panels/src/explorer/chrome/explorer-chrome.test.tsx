// 工具条 / 面包屑 / 状态栏的静态渲染冒烟：bun test 无 DOM，用 react-dom/server 断言结构与 testid。
// 文案键可能尚未落库，所以不对译文做断言。

import { describe, expect, test } from 'bun:test';
import { I18N_RESOURCES } from '@vibeterm/shared';
import type { FileRootDto } from '@vibeterm/shared';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { ExplorerBreadcrumb } from './explorer-breadcrumb';
import { shortcutGroups } from './explorer-shortcuts-dialog';
import { ExplorerStatusBar } from './explorer-status-bar';
import { ExplorerToolbar, type ExplorerToolbarProps } from './explorer-toolbar';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: I18N_RESOURCES,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function render(element: ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

/** 取出带某个 testid 的起始标签，用来断言它自身的属性 */
function openTag(html: string, testId: string): string {
  const match = html.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) throw new Error(`missing data-testid="${testId}"`);
  return match[0];
}

const ROOT: FileRootDto = {
  id: 'r-app',
  deviceId: 'd-local',
  deviceName: '应用服务器',
  deviceType: 'local',
  path: '/srv/app',
  name: 'app',
  enabled: true,
  sortOrder: 0,
};

const OTHER_ROOT: FileRootDto = { ...ROOT, id: 'r-docs', path: '/srv/docs', name: 'docs' };

const noop = () => undefined;

function toolbarProps(overrides: Partial<ExplorerToolbarProps> = {}): ExplorerToolbarProps {
  return {
    canBack: true,
    canForward: true,
    canUp: true,
    busy: false,
    rootPath: ROOT.path,
    rootName: ROOT.name,
    path: '/srv/app/src/ui',
    roots: [ROOT],
    rootId: ROOT.id,
    viewMode: 'list',
    showHidden: false,
    query: '',
    filterInputRef: { current: null },
    onBack: noop,
    onForward: noop,
    onUp: noop,
    onRefresh: noop,
    onNavigate: noop,
    onSwitchRoot: noop,
    onNewFolder: noop,
    onUpload: noop,
    onViewModeChange: noop,
    onShowHiddenChange: noop,
    onQueryChange: noop,
    onShowShortcuts: noop,
    ...overrides,
  };
}

describe('ExplorerToolbar', () => {
  test('渲染全部控件', () => {
    const html = render(<ExplorerToolbar {...toolbarProps()} />);
    for (const testId of [
      'explorer-toolbar',
      'explorer-back',
      'explorer-forward',
      'explorer-up',
      'explorer-refresh',
      'explorer-breadcrumb',
      'explorer-filter',
      'explorer-new-folder',
      'explorer-upload',
      'explorer-view-list',
      'explorer-view-grid',
      'explorer-more',
    ]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
  });

  test('每个图标按钮都有 aria-label', () => {
    const html = render(<ExplorerToolbar {...toolbarProps()} />);
    for (const testId of [
      'explorer-back',
      'explorer-forward',
      'explorer-up',
      'explorer-refresh',
      'explorer-new-folder',
      'explorer-upload',
      'explorer-view-list',
      'explorer-view-grid',
      'explorer-more',
    ]) {
      expect(openTag(html, testId)).toMatch(/aria-label="[^"]+"/);
    }
  });

  test('后退 / 前进 / 上一级按能力禁用', () => {
    const html = render(
      <ExplorerToolbar {...toolbarProps({ canBack: false, canForward: false, canUp: false })} />
    );
    for (const testId of ['explorer-back', 'explorer-forward', 'explorer-up']) {
      expect(openTag(html, testId)).toContain(' disabled=""');
    }
    expect(openTag(html, 'explorer-refresh')).not.toContain(' disabled=""');

    const enabled = render(<ExplorerToolbar {...toolbarProps()} />);
    expect(openTag(enabled, 'explorer-back')).not.toContain(' disabled=""');
  });

  test('busy 时刷新图标旋转', () => {
    expect(render(<ExplorerToolbar {...toolbarProps({ busy: true })} />)).toContain('animate-spin');
    expect(render(<ExplorerToolbar {...toolbarProps()} />)).not.toContain('animate-spin');
  });

  test('视图切换用 aria-pressed 标出当前模式', () => {
    const list = render(<ExplorerToolbar {...toolbarProps({ viewMode: 'list' })} />);
    expect(openTag(list, 'explorer-view-list')).toContain('aria-pressed="true"');
    expect(openTag(list, 'explorer-view-grid')).toContain('aria-pressed="false"');

    const grid = render(<ExplorerToolbar {...toolbarProps({ viewMode: 'grid' })} />);
    expect(openTag(grid, 'explorer-view-list')).toContain('aria-pressed="false"');
    expect(openTag(grid, 'explorer-view-grid')).toContain('aria-pressed="true"');
  });

  test('筛选框回显查询词，有内容时出现清除按钮', () => {
    const empty = render(<ExplorerToolbar {...toolbarProps()} />);
    expect(openTag(empty, 'explorer-filter')).toContain('value=""');
    expect(empty).not.toContain('data-testid="explorer-filter-clear"');

    const typed = render(<ExplorerToolbar {...toolbarProps({ query: 'readme' })} />);
    expect(openTag(typed, 'explorer-filter')).toContain('value="readme"');
    expect(typed).toContain('data-testid="explorer-filter-clear"');
  });

  test('只有多个根时根这一级才是切换下拉', () => {
    const single = render(<ExplorerToolbar {...toolbarProps()} />);
    expect(openTag(single, 'explorer-crumb-0')).not.toContain('data-root-switcher');

    const multi = render(<ExplorerToolbar {...toolbarProps({ roots: [ROOT, OTHER_ROOT] })} />);
    expect(openTag(multi, 'explorer-crumb-0')).toContain('data-root-switcher');
  });
});

describe('ExplorerBreadcrumb', () => {
  test('根到当前目录逐级渲染，最后一级不可点', () => {
    const html = render(
      <ExplorerBreadcrumb
        rootPath="/srv/app"
        rootName="app"
        path="/srv/app/src/ui"
        onNavigate={noop}
      />
    );
    expect(openTag(html, 'explorer-crumb-0')).toStartWith('<button');
    expect(openTag(html, 'explorer-crumb-1')).toStartWith('<button');
    const last = openTag(html, 'explorer-crumb-2');
    expect(last).toStartWith('<span');
    expect(last).toContain('aria-current="location"');
    expect(last).toContain('font-medium');
    expect(html).not.toContain('data-testid="explorer-crumb-3"');
    expect(html).toContain('>src<');
    expect(html).toContain('>ui<');
  });

  test('默认是面包屑形态，带编辑入口，不渲染输入框', () => {
    const html = render(
      <ExplorerBreadcrumb rootPath="/srv/app" rootName="app" path="/srv/app" onNavigate={noop} />
    );
    expect(html).toContain('data-testid="explorer-path-edit"');
    expect(html).not.toContain('data-testid="explorer-path-input"');
  });
});

describe('ExplorerStatusBar', () => {
  test('无选中时选中段隐藏', () => {
    const html = render(
      <ExplorerStatusBar total={12} selectedCount={0} selectedBytes={null} truncated={false} />
    );
    expect(html).toContain('data-testid="explorer-status"');
    expect(openTag(html, 'explorer-status')).toContain('tabular-nums');
    const selected = openTag(html, 'explorer-status-selected');
    expect(selected).toContain('opacity-0');
    expect(selected).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-testid="explorer-status-truncated"');
  });

  test('有选中时显示数量与合计大小', () => {
    const html = render(
      <ExplorerStatusBar total={12} selectedCount={3} selectedBytes={2048} truncated={false} />
    );
    const selected = openTag(html, 'explorer-status-selected');
    expect(selected).toContain('opacity-100');
    expect(selected).toContain('data-visible="true"');
    expect(html).toContain('data-testid="explorer-status-bytes"');
  });

  test('大小未知时不渲染字节数', () => {
    const html = render(
      <ExplorerStatusBar total={12} selectedCount={3} selectedBytes={null} truncated={false} />
    );
    expect(html).not.toContain('data-testid="explorer-status-bytes"');
  });

  test('截断时右侧出现提示', () => {
    const html = render(
      <ExplorerStatusBar total={2000} selectedCount={0} selectedBytes={null} truncated />
    );
    expect(openTag(html, 'explorer-status-truncated')).toContain('ml-auto');
  });
});

describe('shortcutGroups', () => {
  test('首组以三行方向键说明开头', () => {
    const [navigation] = shortcutGroups(false);
    expect(navigation?.slice(0, 3).map((row) => row.id)).toEqual(['move', 'extend', 'typeAhead']);
  });

  test('每条绑定了按键的命令恰好出现一次，且都有键帽', () => {
    for (const apple of [false, true]) {
      const rows = shortcutGroups(apple).flat();
      const ids = rows.map((row) => row.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain('rename');
      expect(ids).toContain('showShortcuts');
      for (const row of rows) {
        expect(row.alternatives.length).toBeGreaterThan(0);
        expect(row.alternatives.every((caps) => caps.length > 0)).toBe(true);
      }
    }
  });

  test('扩展选择行按平台显示 Shift', () => {
    const extend = (apple: boolean) =>
      shortcutGroups(apple)[0]?.find((row) => row.id === 'extend')?.alternatives[0]?.[0];
    expect(extend(false)).toBe('Shift');
    expect(extend(true)).toBe('⇧');
  });
});
