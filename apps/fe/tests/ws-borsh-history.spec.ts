import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';
import { attachPaneFeedCollector, readVisibleTerminalText } from './helpers/ws-borsh';

// canonical 首屏事务（ScreenBegin → ScreenChunk* → ScreenCommit）是 legacy
// SWITCH_ACK → TERM_HISTORY → LIVE_RESUME 屏障的替代物：1.1.23 起没有 legacy 回退，
// 首屏拿不到就只能是空白终端。
test('ws-borsh: canonical screen feed applies pane ready marker on initial load', async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    (window as any).__TMEX_E2E_DEBUG = true;
  });

  const received = attachPaneFeedCollector(page);

  const sessionName = `tmex-e2e-history-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  expect(paneIds.length >= 1).toBeTruthy();

  const name = `e2e-borsh-history-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const targetPaneId = paneIds[0];

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => page.evaluate(() => Boolean((window as any).__tmexE2eXterm)), {
        timeout: 20_000,
      })
      .toBeTruthy();
    await expect
      .poll(() => received.selectTokenByPane.get(targetPaneId) ?? null, { timeout: 20_000 })
      .toBeTruthy();

    await expect
      .poll(() => received.paneContent(targetPaneId), { timeout: 20_000 })
      .toContain('PANE0_READY');

    expect(received.sawCanonicalEvent).toBe(true);
    const canonicalText =
      (received.canonicalScreenTextByPane.get(targetPaneId) ?? '') +
      (received.canonicalOutputTextByPane.get(targetPaneId) ?? '');
    expect(canonicalText).toContain('PANE0_READY');

    // 首屏事务必须成对完成，且 Begin 早于 Commit；同一 requestId 贯穿两端
    await expect
      .poll(() => received.screenCommitted(targetPaneId), { timeout: 20_000 })
      .toBeTruthy();
    const phases = received.screenPhasesByPane.get(targetPaneId) ?? [];
    const beginIndex = phases.findIndex((entry) => entry.phase === 'begin');
    const commitIndex = phases.findIndex((entry) => entry.phase === 'commit');
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(beginIndex);
    expect(phases[commitIndex]?.requestId).toBe(phases[beginIndex]?.requestId);

    await expect
      .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
      .toContain('PANE0_READY');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
