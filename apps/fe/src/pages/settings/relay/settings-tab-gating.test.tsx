// 设置页「中继」标签的门禁：`/api/relay/status` 判定可用才摆这个标签。
// 与 SettingsPage.test.tsx 同一套静态渲染做法；这里只关心多出来的那一个标签。

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

// 与 SettingsPage.test.tsx 用的是同一组替身（形状一致）：站点设置表单与两个面板都与本用例无关。
mock.module('../use-site-settings-form', () => ({
  useSiteSettingsForm: () => ({
    draft: {},
    updateDraft: () => undefined,
    save: () => undefined,
    isSaving: false,
  }),
}));
mock.module('../general-settings-tab', () => ({
  GeneralSettingsTab: () => <div data-testid="general-settings-tab" />,
}));
mock.module('../notification-settings-tab', () => ({
  NotificationSettingsTab: () => <div data-testid="notification-settings-tab" />,
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { MemoryRouter } = await import('react-router');
const {
  default: SettingsPage,
  settingsTabFromParam,
  chunkPreloadOrder,
} = await import('../../SettingsPage');
const { resetRelayAdminStateForTest, setRelayAdminStateForTest } = await import(
  './relay-status-store'
);

function render(entry = '/settings'): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[entry]}>
      <SettingsPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  resetRelayAdminStateForTest();
});

describe('「中继」标签的门禁', () => {
  test('结论未定时不摆标签（探测还没回来，宁可不闪一下）', () => {
    expect(render()).not.toContain('data-testid="settings-tab-relay"');
  });

  test('404 判定角色缺席：标签不出现', () => {
    setRelayAdminStateForTest({ availability: 'unavailable' });
    expect(render()).not.toContain('data-testid="settings-tab-relay"');
  });

  test('可用时标签出现，紧挨「多节点互联」右侧', () => {
    setRelayAdminStateForTest({ availability: 'available' });
    const html = render();
    expect(html).toContain('data-testid="settings-tab-relay"');
    expect(html).toContain('relay.admin.tabLabel');
    expect(html.indexOf('settings-tab-relay')).toBeGreaterThan(html.indexOf('settings-tab-nodes'));
    expect(html.indexOf('settings-tab-relay')).toBeLessThan(html.indexOf('settings-tab-share'));
  });

  test('未登录（401）同样不摆标签', () => {
    setRelayAdminStateForTest({ availability: 'unauthorized' });
    expect(render()).not.toContain('data-testid="settings-tab-relay"');
  });
});

describe('`?tab=relay` 深链', () => {
  test('是合法标签值（角色缺席时由标签页本身给说明）', () => {
    expect(settingsTabFromParam('relay')).toBe('relay');
  });

  test('不进空闲预热队列：绝大多数机器不是中继，不该白拉这块 chunk', () => {
    // 常规标签共 8 个，各自排出 7 个待预热；站在「中继」上时那 8 个一个不少——
    // 说明预热池里从来没有中继自己。
    expect(chunkPreloadOrder('general')).toHaveLength(7);
    expect(chunkPreloadOrder('relay')).toHaveLength(8);
  });
});
