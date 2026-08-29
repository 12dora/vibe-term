// 设置页标签栏：「节点」标签的位置与分派。
// 无 DOM 测试环境，用 react-dom/server 静态渲染（与 NodesPage / NodesTab 测试同一套做法），
// 因此点击驱动不了状态——这里用 SettingsPage 自己的 `activeTab` 初值渲染一次，
// 断言标签项齐全、只有当前标签的面板被挂载；NodesTab 自身的分派在 nodes/nodes-tab.test.tsx 里覆盖。

import { describe, expect, mock, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 站点设置表单与「通用」面板都走 React Query + runtime store，本用例与它们无关。
// 这两个模块只有 SettingsPage 引用，替身不会漏到别的测试文件。
mock.module('./settings/use-site-settings-form', () => ({
  useSiteSettingsForm: () => ({
    draft: {},
    updateDraft: () => undefined,
    showRefreshNotice: false,
    save: () => undefined,
    isSaving: false,
  }),
}));
mock.module('./settings/general-settings-tab', () => ({
  GeneralSettingsTab: () => <div data-testid="general-settings-tab" />,
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: SettingsPage } = await import('./SettingsPage');

const TAB_IDS = ['general', 'terminal', 'devicesAndFiles', 'nodes', 'notifications', 'ai'];

describe('SettingsPage 标签栏', () => {
  test('六个标签都在，「节点」排在设备与文件与通知之间', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
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

  test('面板互斥：默认标签下只挂通用面板，NodesTab 不渲染', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html).toContain('data-testid="general-settings-tab"');
    expect(html).not.toContain('data-testid="settings-nodes-tab"');
  });
});
