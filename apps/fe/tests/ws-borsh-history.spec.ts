import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { wsBorsh } from '@tmex/shared';
import { createTwoPaneSession, ensureCleanSession } from './helpers/tmux';
import { attachPaneFeedCollector, readVisibleTerminalText } from './helpers/ws-borsh';

const CANONICAL_STATE_KILL_SWITCH_KEY = 'tmex.disable-canonical-state';

function runHistoryLoad(options: { canonical: boolean }) {
  return async ({ page, request }: { page: Page; request: APIRequestContext }) => {
    await page.addInitScript(
      ({
        disableCanonical,
        killSwitchKey,
      }: { disableCanonical: boolean; killSwitchKey: string }) => {
        (window as any).__TMEX_E2E_DEBUG = true;
        if (disableCanonical) localStorage.setItem(killSwitchKey, 'true');
      },
      { disableCanonical: !options.canonical, killSwitchKey: CANONICAL_STATE_KILL_SWITCH_KEY }
    );

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

      const tokenHex = received.selectTokenByPane.get(targetPaneId)!;
      await expect
        .poll(() => received.paneContent(targetPaneId), { timeout: 20_000 })
        .toContain('PANE0_READY');

      if (options.canonical) {
        expect(received.sawCanonicalEvent).toBe(true);
        const canonicalText =
          (received.canonicalScreenTextByPane.get(targetPaneId) ?? '') +
          (received.canonicalOutputTextByPane.get(targetPaneId) ?? '');
        expect(canonicalText).toContain('PANE0_READY');
        expect(received.historyTextByToken.get(tokenHex) ?? '').not.toContain('PANE0_READY');
      } else {
        expect(received.historyTextByToken.get(tokenHex) ?? '').toContain('PANE0_READY');
        expect(received.sawCanonicalEvent).toBe(false);
      }

      await expect
        .poll(() => received.barrierKindsByToken.get(tokenHex) ?? [], { timeout: 20_000 })
        .toContain(wsBorsh.KIND_SWITCH_ACK);
      await expect
        .poll(() => received.barrierKindsByToken.get(tokenHex) ?? [], { timeout: 20_000 })
        .toContain(wsBorsh.KIND_LIVE_RESUME);

      await expect
        .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
        .toContain('PANE0_READY');
    } finally {
      await request.delete(`/api/devices/${deviceId}`);
      ensureCleanSession(sessionName);
    }
  };
}

test(
  'ws-borsh: canonical screen feed applies pane ready marker on initial load',
  runHistoryLoad({ canonical: true })
);

test(
  'ws-borsh: legacy TERM_HISTORY applies pane ready marker on initial load',
  runHistoryLoad({ canonical: false })
);
