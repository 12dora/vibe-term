import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';
import { attachPaneFeedCollector, readVisibleTerminalText } from './helpers/ws-borsh';

const CANONICAL_STATE_KILL_SWITCH_KEY = 'tmex.disable-canonical-state';

function runPaneRoute(options: { canonical: boolean }) {
  return async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await page.addInitScript(
      ({
        disableCanonical,
        killSwitchKey,
      }: { disableCanonical: boolean; killSwitchKey: string }) => {
        if (disableCanonical) localStorage.setItem(killSwitchKey, 'true');
      },
      { disableCanonical: !options.canonical, killSwitchKey: CANONICAL_STATE_KILL_SWITCH_KEY }
    );

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

      const tokenHex = received.selectTokenByPane.get(targetPaneId);
      expect(tokenHex).toBeTruthy();

      await expect
        .poll(() => received.paneContent(targetPaneId), { timeout: 20_000 })
        .toContain('PANE1_READY');

      if (options.canonical) {
        expect(received.sawCanonicalEvent).toBe(true);
        const canonicalText =
          (received.canonicalScreenTextByPane.get(targetPaneId) ?? '') +
          (received.canonicalOutputTextByPane.get(targetPaneId) ?? '');
        expect(canonicalText).toContain('PANE1_READY');
        expect(received.historyTextByToken.get(tokenHex ?? '') ?? '').not.toContain('PANE1_READY');
      } else {
        expect(received.historyTextByToken.get(tokenHex ?? '') ?? '').toContain('PANE1_READY');
        expect(received.sawCanonicalEvent).toBe(false);
      }

      await expect
        .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
        .toContain('PANE1_READY');

      await page.waitForTimeout(1000);
      await expect(page.evaluate(() => window.location.pathname)).resolves.toBe(targetPath);
    } finally {
      await request.delete(`/api/devices/${deviceId}`);
      ensureCleanSession(sessionName);
    }
  };
}

test(
  'ws-borsh: canonical feed preserves encoded pane id and loads target pane',
  runPaneRoute({ canonical: true })
);

test(
  'ws-borsh: legacy TERM_HISTORY preserves encoded pane id and loads target pane',
  runPaneRoute({ canonical: false })
);
