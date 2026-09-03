import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';
import { attachPaneFeedCollector, readVisibleTerminalText } from './helpers/ws-borsh';

// canonical PaneTarget 里的 paneId 是原样 UTF-8（`%3` 之类），路由要靠它把首屏/输出
// 送回 URL 里被 encodeURIComponent 编过的那个 pane，不能串到同 window 的另一个 pane。
test('ws-borsh: canonical feed preserves encoded pane id and loads target pane', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-pane-route-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-borsh-pane-route-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const targetPaneId = paneIds[1];
  const otherPaneId = paneIds[0];
  const targetPath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(targetPaneId)}`;
  const received = attachPaneFeedCollector(page);

  try {
    await page.goto(targetPath);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => page.evaluate(() => window.location.pathname), { timeout: 20_000 })
      .toBe(targetPath);

    await expect
      .poll(() => received.selectTokenByPane.get(targetPaneId) ?? null, { timeout: 20_000 })
      .toBeTruthy();

    await expect
      .poll(() => received.paneContent(targetPaneId), { timeout: 20_000 })
      .toContain('PANE1_READY');

    expect(received.sawCanonicalEvent).toBe(true);
    const canonicalText =
      (received.canonicalScreenTextByPane.get(targetPaneId) ?? '') +
      (received.canonicalOutputTextByPane.get(targetPaneId) ?? '');
    expect(canonicalText).toContain('PANE1_READY');
    // 目标 pane 的标记不能落到同 window 的另一个 pane 上
    expect(received.paneContent(otherPaneId)).not.toContain('PANE1_READY');
    // 首屏事务确实是按 canonical PaneTarget 投递给目标 pane 的
    await expect
      .poll(() => received.screenCommitted(targetPaneId), { timeout: 20_000 })
      .toBeTruthy();

    await expect
      .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
      .toContain('PANE1_READY');

    await page.waitForTimeout(1000);
    await expect(page.evaluate(() => window.location.pathname)).resolves.toBe(targetPath);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
