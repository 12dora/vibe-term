// 回归：pane 挂了 Agent session 后，PaneRow 的菜单/关闭按钮若锚在包含
// PaneSessionBranch 的外层容器上，top-1/2 会随容器撑高而整体下滑错位。
// 断言两个按钮的垂直中心始终对齐 pane 行本身。

import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

test.describe('sidebar pane row action buttons alignment', () => {
  const sessionName = `tmex-e2e-pane-menu-${Date.now()}`;
  let deviceId: string;
  let windowId: string;
  let paneIds: string[];
  let agentSessionId: string | undefined;

  test.beforeAll(async ({ request }) => {
    const created = createTwoPaneSession(sessionName);
    paneIds = created.paneIds;
    windowId = created.windowId;

    const deviceRes = await request.post('/api/devices', {
      data: {
        name: `e2e-pane-menu-${Date.now()}`,
        type: 'local',
        session: sessionName,
        authMode: 'auto',
      },
    });
    expect(deviceRes.ok()).toBeTruthy();
    const device = (await deviceRes.json()) as { device: { id: string } };
    deviceId = device.device.id;

    // 直接走 API 给 pane 挂一条 Agent session（无需真实 LLM，仅需列表里出现分支节点）
    const sessionRes = await request.post('/api/agent/sessions', {
      data: { deviceId, paneId: paneIds[0], modelId: 'mock-model' },
    });
    expect(sessionRes.ok()).toBeTruthy();
    const session = (await sessionRes.json()) as { session: { id: string } };
    agentSessionId = session.session.id;
  });

  test.afterAll(async ({ request }) => {
    if (agentSessionId) {
      await request.delete(`/api/agent/sessions/${agentSessionId}`).catch(() => undefined);
    }
    if (deviceId) {
      await request.delete(`/api/devices/${deviceId}`).catch(() => undefined);
    }
    ensureCleanSession(sessionName);
  });

  test('menu and close buttons stay centered on the pane row when session branch exists', async ({
    page,
  }) => {
    const paneId = paneIds[0];
    await page.goto(`/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    // Panes 分区默认展开、常驻可见，无需切换
    const paneRow = page.getByTestId(`pane-item-${paneId}`);
    await expect(paneRow).toBeVisible({ timeout: 15_000 });

    // 回归前提：该 pane 下方确实渲染了 session 分支（正是它把旧锚点容器撑高）
    await expect(page.getByTestId(`agent-session-item-${agentSessionId}`)).toBeVisible({
      timeout: 15_000,
    });

    const rowBox = await paneRow.boundingBox();
    expect(rowBox).not.toBeNull();
    const rowCenter = (rowBox?.y ?? 0) + (rowBox?.height ?? 0) / 2;

    for (const kind of ['menu', 'close'] as const) {
      const button = page.getByTestId(`pane-${kind}-${paneId}`);
      const buttonBox = await button.boundingBox();
      expect(buttonBox, `pane ${kind} button should render`).not.toBeNull();
      const buttonCenter = (buttonBox?.y ?? 0) + (buttonBox?.height ?? 0) / 2;
      expect(
        Math.abs(buttonCenter - rowCenter),
        `pane ${kind} button should stay vertically centered on the pane row`
      ).toBeLessThanOrEqual(3);
    }
  });
});
