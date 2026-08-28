import { expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, getPaneSize } from './helpers/tmux';
import { KIND, decodeEnvelope, isGatewayWsUrl } from './helpers/ws-borsh';

async function readTerminalSize(page: import('@playwright/test').Page): Promise<{
  cols: number;
  rows: number;
} | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return { cols: term.cols, rows: term.rows };
  });
}

function attachFrameCounter(page: import('@playwright/test').Page): {
  read: () => { resize: number; sync: number; windowStyle: number };
} {
  const counts = { resize: 0, sync: 0, windowStyle: 0 };

  page.on('websocket', (ws) => {
    if (!isGatewayWsUrl(ws.url())) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind === KIND.TERM_RESIZE) counts.resize += 1;
      if (envelope.kind === KIND.TERM_SYNC_SIZE) counts.sync += 1;
      if (envelope.kind === 0x020a) counts.windowStyle += 1;
    });
  });

  return {
    read() {
      return { ...counts };
    },
  };
}

test('ws-borsh: rapid theme toggle × browser resize keeps pane cols/rows stable (<2 cells drift)', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-resize-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[0];

  const name = `e2e-theme-resize-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const counter = attachFrameCounter(page);

  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const termSize = await readTerminalSize(page);
          const paneSize = getPaneSize(targetPaneId);
          if (!termSize) return 'terminal-unavailable';
          return Math.abs(termSize.cols - paneSize.cols) + Math.abs(termSize.rows - paneSize.rows);
        },
        { timeout: 20_000 }
      )
      .toBeLessThanOrEqual(1);

    const paneSizeBefore = getPaneSize(targetPaneId);

    for (let i = 0; i < 4; i++) {
      const theme = i % 2 === 0 ? 'light' : 'dark';
      const res = await request.post('/api/settings/theme', { data: { theme } });
      expect(res.ok()).toBeTruthy();
      await page.waitForTimeout(50);
      await page.setViewportSize({
        width: 1200 + (i % 2 === 0 ? -50 : 50),
        height: 800 + (i % 2 === 0 ? -30 : 30),
      });
    }

    await page.waitForTimeout(2_000);

    const paneSizeAfter = getPaneSize(targetPaneId);
    const colsDrift = Math.abs(paneSizeAfter.cols - paneSizeBefore.cols);
    const rowsDrift = Math.abs(paneSizeAfter.rows - paneSizeBefore.rows);

    expect(colsDrift).toBeLessThan(2);
    expect(rowsDrift).toBeLessThan(2);

    const counts = counter.read();
    expect(counts.windowStyle).toBeGreaterThanOrEqual(1);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});
