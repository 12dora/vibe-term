// 移动端视口 spot check：375x812 下 agent 现为左 Sidebar 的 Agent Tab，
// sidebar 以 Sheet 形态打开；进入 Agent Tab 后输入框可见可用。
// WatchDialog 可打开且表单可达。真后端 + 本机 tmux。

import { expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

test.use({ viewport: { width: 375, height: 812 } });

test.describe
  .serial('mobile: agent panel and watch dialog', () => {
    let deviceId: string;
    let windowId: string;
    let paneId: string;
    const sessionName = `tmex-e2e-mobile-aw-${Date.now()}`;

    test.beforeAll(async ({ request }) => {
      ensureCleanSession(sessionName);
      tmux(`new-session -d -s ${sessionName} "sh -lc 'echo MOBILE_PANE_READY; exec sh'"`);
      paneId = tmux(`list-panes -t ${sessionName}:0 -F '#{pane_id}'`).trim();
      windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`).trim();

      const deviceRes = await request.post('/api/devices', {
        data: {
          name: `e2e-mobile-aw-${Date.now()}`,
          type: 'local',
          session: sessionName,
          authMode: 'auto',
        },
      });
      expect(deviceRes.ok()).toBeTruthy();
      const created = (await deviceRes.json()) as { device: { id: string } };
      deviceId = created.device.id;
    });

    test.afterAll(async ({ request }) => {
      if (deviceId) {
        await request.delete(`/api/devices/${deviceId}`).catch(() => undefined);
      }
      ensureCleanSession(sessionName);
    });

    test('agent tab opens in sidebar sheet with usable input', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

      // 移动端：从顶栏打开 sidebar Sheet，显式展开 Agent 分区
      await page.getByTestId('mobile-sidebar-open').click();
      await expect(page.getByTestId('mobile-sidebar-sheet')).toBeVisible();

      await page.getByTestId('sidebar-section-toggle-agent').click();

      await expect(page.getByTestId('agent-tab')).toBeVisible();

      // 当前 pane 自动起草；小屏下 Agent 分区内容可在分区内滚动，滚到输入框后可见可用
      const textarea = page.getByTestId('agent-chat-input-textarea');
      await expect(textarea).toBeVisible();
      await textarea.scrollIntoViewIfNeeded();
      await expect(textarea).toBeInViewport();
      await expect(textarea).toBeEnabled();

      // 模型选择器可见（Agent 分区头部）
      await expect(page.getByTestId('agent-model-picker')).toBeVisible();

      // Agent 展开时其他一级分区收起
      await expect(page.getByTestId('sidebar-section-toggle-panes')).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      await expect(page.getByTestId('sidebar-section-toggle-files')).toHaveAttribute(
        'aria-expanded',
        'false'
      );

      // 关闭 Sheet 回到终端
      await page.getByTestId('mobile-sidebar-close').click();
      await expect(page.getByTestId('mobile-sidebar-sheet')).toHaveCount(0);
    });

    test('watch dialog opens and rule form is reachable', async ({ page }) => {
      await page.goto(
        `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`
      );
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

      await page.getByTestId('watch-open-button').click();
      await expect(page.getByTestId('watch-dialog')).toBeVisible();

      await page.getByTestId('watch-rule-add').click();
      await expect(page.getByTestId('watch-rule-form')).toBeVisible();
      await expect(page.getByTestId('watch-form-name')).toBeInViewport();
      await page.getByTestId('watch-form-name').fill('mobile spot check');
      await expect(page.getByTestId('watch-form-pattern')).toBeVisible();

      // 保存按钮可达：表单长于视口，dialog 内容可滚动到底部的保存按钮
      await page.getByTestId('watch-form-save').scrollIntoViewIfNeeded();
      await expect(page.getByTestId('watch-form-save')).toBeInViewport();
    });
  });
