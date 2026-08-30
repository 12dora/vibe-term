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
const { default: SettingsPage, settingsTabFromParam } = await import('./SettingsPage');

const TAB_IDS = [
  'general',
  'terminal',
  'remoteAccess',
  'devicesAndFiles',
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

describe('SettingsPage 标签栏', () => {
  test('七个标签都在，「节点」排在设备与文件与通知之间', () => {
    const html = render();
    for (const tab of TAB_IDS) {
      expect(html).toContain(`data-testid="settings-tab-${tab}"`);
    }
    expect(html.indexOf('settings-tab-nodes')).toBeGreaterThan(
      html.indexOf('settings-tab-devicesAndFiles')
    );
    expect(html.indexOf('settings-tab-nodes')).toBeLessThan(
      html.indexOf('settings-tab-notifications')
    );
    expect(html).toContain('settings.tabGroup.nodes');
  });

  test('「远程访问」紧挨在「终端」右侧', () => {
    const html = render();
    expect(html.indexOf('settings-tab-remoteAccess')).toBeGreaterThan(
      html.indexOf('settings-tab-terminal')
    );
    expect(html.indexOf('settings-tab-remoteAccess')).toBeLessThan(
      html.indexOf('settings-tab-devicesAndFiles')
    );
    expect(html).toContain('settings.tabGroup.remoteAccess');
  });

  test('面板互斥：默认标签下只挂通用面板，NodesTab / 远程访问都不渲染', () => {
    const html = render();
    expect(html).toContain('data-testid="general-settings-tab"');
    expect(html).not.toContain('data-testid="settings-nodes-tab"');
    expect(html).not.toContain('data-testid="settings-remote-access-tab"');
  });

  test('`?tab=` 选中对应标签的面板（用有替身的「通知」面板验证深链）', () => {
    const html = render('/settings?tab=notifications');
    expect(html).toContain('data-testid="notification-settings-tab"');
    expect(html).not.toContain('data-testid="general-settings-tab"');
  });

  test('`?tab=` 不是合法标签时退回「通用」', () => {
    const html = render('/settings?tab=bogus');
    expect(html).toContain('data-testid="general-settings-tab"');
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
