// 设置页标签栏：「节点」标签的位置与分派，以及 `?tab=` 深链选中的标签。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 NodesTab 测试同一套做法），
// 因此点击驱动不了状态——这里用不同的 `?tab=` 初值各渲染一次，
// 断言标签项齐全、只有对应标签的面板被挂载；NodesTab 自身的分派在 settings/nodes/nodes-tab.test.tsx 里覆盖。

import { describe, expect, mock, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 站点设置表单与「通用」/「通知」面板都走 React Query + runtime store，本用例与它们无关。
// 这几个模块只有 SettingsPage 引用，替身不会漏到别的测试文件。
mock.module('./settings/use-site-settings-form', () => ({
  useSiteSettingsForm: () => ({
    draft: {},
    updateDraft: () => undefined,
    save: () => undefined,
    isSaving: false,
  }),
}));
mock.module('./settings/general-settings-tab', () => ({
  GeneralSettingsTab: () => <div data-testid="general-settings-tab" />,
}));
mock.module('./settings/notification-settings-tab', () => ({
  NotificationSettingsTab: () => <div data-testid="notification-settings-tab" />,
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const {
  default: SettingsPage,
  settingsTabFromParam,
  chunkPreloadOrder,
  settingsTabBarItems,
} = await import('./SettingsPage');

const TAB_IDS = [
  'general',
  'terminal',
  'devicesAndFiles',
  'remoteAccess',
  'nodes',
  'notifications',
  'ai',
];

function render(entry = '/settings'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <SettingsPage />
    </MemoryRouter>
  );
}

// 各标签面板是 React.lazy：首帧只出 Suspense fallback，等模块解析完再渲染一次才有面板。
async function renderResolved(entry = '/settings'): Promise<string> {
  render(entry);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return render(entry);
}

describe('SettingsPage 标签栏', () => {
  test('七个标签都在，「节点」排在远程访问与通知之间', () => {
    const html = render();
    for (const tab of TAB_IDS) {
      expect(html).toContain(`data-testid="settings-tab-${tab}"`);
    }
    expect(html.indexOf('settings-tab-nodes')).toBeGreaterThan(
      html.indexOf('settings-tab-remoteAccess')
    );
    expect(html.indexOf('settings-tab-nodes')).toBeLessThan(
      html.indexOf('settings-tab-notifications')
    );
    expect(html).toContain('settings.tabGroup.nodes');
  });

  test('「设备与文件」紧挨在「终端」右侧，「远程访问」在其后', () => {
    const html = render();
    expect(html.indexOf('settings-tab-devicesAndFiles')).toBeGreaterThan(
      html.indexOf('settings-tab-terminal')
    );
    expect(html.indexOf('settings-tab-remoteAccess')).toBeGreaterThan(
      html.indexOf('settings-tab-devicesAndFiles')
    );
    expect(html).toContain('settings.tabGroup.remoteAccess');
  });

  test('面板互斥：默认标签下只挂通用面板，NodesTab / 远程访问都不渲染', async () => {
    const html = await renderResolved();
    expect(html).toContain('data-testid="general-settings-tab"');
    expect(html).not.toContain('data-testid="settings-nodes-tab"');
    expect(html).not.toContain('data-testid="settings-remote-access-tab"');
  });

  test('`?tab=` 选中对应标签的面板（用有替身的「通知」面板验证深链）', async () => {
    // 未加载过的标签首帧只有 Suspense fallback，说明面板确实被拆成了独立分块。
    expect(render('/settings?tab=notifications')).not.toContain(
      'data-testid="notification-settings-tab"'
    );
    const html = await renderResolved('/settings?tab=notifications');
    expect(html).toContain('data-testid="notification-settings-tab"');
    expect(html).not.toContain('data-testid="general-settings-tab"');
  });

  test('`?tab=` 不是合法标签时退回「通用」', async () => {
    const html = await renderResolved('/settings?tab=bogus');
    expect(html).toContain('data-testid="general-settings-tab"');
  });
});

// 中继标签只在本机带中继角色时挂上，门禁本身在 settings/relay/settings-tab-gating.test.tsx 里覆盖。
describe('settingsTabBarItems', () => {
  test('没有中继角色时就是七个常规标签', () => {
    expect(settingsTabBarItems(false).map((item) => String(item.value))).toEqual(TAB_IDS);
  });

  test('有中继角色时插在「多节点互联」右侧、「通知」左侧', () => {
    const values = settingsTabBarItems(true).map((item) => String(item.value));
    expect(values).toHaveLength(TAB_IDS.length + 1);
    expect(values[values.indexOf('nodes') + 1]).toBe('relay');
    expect(values.indexOf('relay')).toBeLessThan(values.indexOf('notifications'));
  });
});

// 选中的标签直接由 URL 推导（不另存 state），所以挂载后 query 一变就跟着变——
// 静态渲染点不了按钮，这里直接测那个唯一的解释函数。
describe('settingsTabFromParam', () => {
  test('合法值原样返回', () => {
    for (const tab of TAB_IDS) {
      expect(settingsTabFromParam(tab)).toBe(tab as ReturnType<typeof settingsTabFromParam>);
    }
  });

  test('缺失或不认识的值一律回「通用」', () => {
    expect(settingsTabFromParam(null)).toBe('general');
    expect(settingsTabFromParam('')).toBe('general');
    expect(settingsTabFromParam('bogus')).toBe('general');
    expect(settingsTabFromParam('NODES')).toBe('general');
  });
});

// 空闲预热的排队顺序（调度本身在 settings/chunk-preload.test.ts 里覆盖）。
describe('chunkPreloadOrder', () => {
  test('排除当前标签，其余按标签定义顺序各出现一次', () => {
    for (const tab of TAB_IDS) {
      const order = chunkPreloadOrder(tab as ReturnType<typeof settingsTabFromParam>);
      expect(order).toHaveLength(TAB_IDS.length - 1);
      expect(new Set(order).size).toBe(order.length);
    }
  });

  test('不同标签排出的顺序确实不同（当前标签被摘掉）', () => {
    const fromGeneral = chunkPreloadOrder('general');
    const fromNodes = chunkPreloadOrder('nodes');
    expect(fromGeneral[0]).not.toBe(fromNodes[0]);
  });
});
