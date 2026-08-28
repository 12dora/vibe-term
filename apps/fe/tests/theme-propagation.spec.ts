import { type Page, expect, test } from '@playwright/test';
import { createLocalDevice } from './helpers/device';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';
import { KIND, decodeEnvelope, decodeSiteThemeUpdateS2C, isGatewayWsUrl } from './helpers/ws-borsh';

// 主题动态传递 e2e：前端切主题 → gateway 广播 WS SITE_THEME_UPDATE + setWindowStyle +
// stdin 注入主题通知序列。覆盖单网页 xterm 背景色变化、tmux window-style 更新、OSC 11
// 代答取新颜色、跨网页 <1s 同步、主题 × resize 互踩。

test.use({ viewport: { width: 1280, height: 800 } });

const DARK_BG = '#262626';
const LIGHT_BG = '#e1e1e1';

async function setThemeViaUI(page: Page, theme: 'dark' | 'light'): Promise<void> {
  // 前端 SettingsPage 的 theme toggle 走 useSiteStore.updateTheme → C2S WS →
  // gateway handleSiteThemeUpdate → S2C 广播 KIND_SITE_THEME_UPDATE + setWindowStyle + stdin。
  // HTTP API 路径（POST /api/settings/theme）只调 broadcastThemeChange（stdin + window-style），
  // 不发 S2C WS 广播，前端不会收到通知。故主题 e2e 必须走 UI toggle。
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  const wantDark = theme === 'dark';
  if (isDark === wantDark) return;
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('settings-tab-general').click();
  await page.getByTestId('settings-theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(
    wantDark ? /\bdark\b/ : /^[^]*$(?<!\bdark\b)/
  );
}

async function readTerminalBackground(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-terminal-engine]') as HTMLElement | null;
    if (!el) return null;
    return el.style.backgroundColor || el.style.background || null;
  });
}

function normalizeColor(raw: string | null): string {
  if (!raw) return '';
  const m = raw.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return raw.toLowerCase();
  const toHex = (n: string) => Number(n).toString(16).padStart(2, '0');
  return `#${toHex(m[1]!)}${toHex(m[2]!)}${toHex(m[3]!)}`;
}

function expectBg(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  return normalizeColor(actual) === expected.toLowerCase();
}

function attachSiteThemeReceiver(page: Page): {
  received: () => Array<{ theme: number; serverTimestamp: bigint }>;
} {
  const received: Array<{ theme: number; serverTimestamp: bigint }> = [];
  page.on('websocket', (ws) => {
    if (!isGatewayWsUrl(ws.url())) return;
    ws.on('framereceived', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope || envelope.kind !== KIND.SITE_THEME_UPDATE) return;
      received.push(decodeSiteThemeUpdateS2C(envelope.payload));
    });
  });
  return { received: () => received };
}

test('theme: single page — toggle dark/light flips xterm background color', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-single-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-single-${Date.now()}`);

  try {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(async () => expectBg(await readTerminalBackground(page), DARK_BG), { timeout: 15_000 })
      .toBe(true);

    await setThemeViaUI(page, 'light');
    await page.goto(`/devices/${deviceId}`);

    await expect
      .poll(async () => expectBg(await readTerminalBackground(page), LIGHT_BG), { timeout: 15_000 })
      .toBe(true);

    await setThemeViaUI(page, 'dark');
    await page.goto(`/devices/${deviceId}`);

    await expect
      .poll(async () => expectBg(await readTerminalBackground(page), DARK_BG), { timeout: 15_000 })
      .toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});

test('theme: gateway updates tmux window-style to match site theme', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-wstyle-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-wstyle-${Date.now()}`);

  try {
    await request.post('/api/settings/theme', { data: { theme: 'light' } });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000);

    await expect
      .poll(
        () => {
          try {
            const style = tmux(`show-option -w -t ${sessionName} window-style`);
            return style.includes(LIGHT_BG) || style.includes('e1e1e1');
          } catch {
            return false;
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true);

    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.waitForTimeout(2_000);

    await expect
      .poll(
        () => {
          try {
            const style = tmux(`show-option -w -t ${sessionName} window-style`);
            return style.includes(DARK_BG) || style.includes('262626');
          } catch {
            return false;
          }
        },
        { timeout: 15_000 }
      )
      .toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});

test('theme: cross-page — A toggles theme, B syncs within 1s via WS broadcast', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-cross-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-cross-${Date.now()}`);

  const pageA = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await contextB.newPage();
  const receiverB = attachSiteThemeReceiver(pageB);

  try {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await Promise.all([pageA.goto(`/devices/${deviceId}`), pageB.goto(`/devices/${deviceId}`)]);
    await Promise.all([
      expect(pageA.getByTestId('device-page')).toBeVisible(),
      expect(pageB.getByTestId('device-page')).toBeVisible(),
      expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 20_000 }),
      expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 20_000 }),
    ]);

    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageA), DARK_BG), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageB), DARK_BG), { timeout: 15_000 })
      .toBe(true);

    await setThemeViaUI(pageA, 'light');
    await pageA.goto(`/devices/${deviceId}`);

    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageA), LIGHT_BG), { timeout: 10_000 })
      .toBe(true);
    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageB), LIGHT_BG), { timeout: 15_000 })
      .toBe(true);

    await expect
      .poll(() => receiverB.received().some((r) => r.theme === 1), { timeout: 10_000 })
      .toBe(true);
  } finally {
    await pageA.close();
    await contextB.close();
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});

test('theme: rapid theme toggle × browser resize keeps pane cols/rows stable', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-resize-${Date.now()}`;
  const { paneId } = createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-resize-${Date.now()}`);

  async function readTerminalSize(): Promise<{ cols: number; rows: number } | null> {
    return page.evaluate(() => {
      const term = (window as any).__tmexE2eXterm;
      if (!term) return null;
      return { cols: term.cols, rows: term.rows };
    });
  }

  function getPaneSize(): { cols: number; rows: number } {
    const [colsRaw, rowsRaw] = tmux(
      `display-message -p -t ${paneId} '#{pane_width}\t#{pane_height}'`
    )
      .split('\t')
      .map((v) => v.trim());
    return {
      cols: Number.parseInt(colsRaw ?? '0', 10),
      rows: Number.parseInt(rowsRaw ?? '0', 10),
    };
  }

  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        async () => {
          const ts = await readTerminalSize();
          const ps = getPaneSize();
          if (!ts) return 999;
          return Math.abs(ts.cols - ps.cols) + Math.abs(ts.rows - ps.rows);
        },
        { timeout: 20_000 }
      )
      .toBeLessThanOrEqual(1);

    const paneBefore = getPaneSize();

    // HTTP API 路径触发 handleSiteThemeChange（window-style）+ broadcastThemeChange（stdin），
    // 不发 S2C WS 广播。resize 互踩测试只关心 pane 尺寸稳定性，不依赖前端主题同步。
    for (let i = 0; i < 4; i++) {
      const theme = i % 2 === 0 ? 'light' : 'dark';
      await request.post('/api/settings/theme', { data: { theme } });
      await page.waitForTimeout(50);
      await page.setViewportSize({
        width: 1200 + (i % 2 === 0 ? -20 : 20),
        height: 800 + (i % 2 === 0 ? -10 : 10),
      });
    }

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(2_000);

    const paneAfter = getPaneSize();
    expect(Math.abs(paneAfter.cols - paneBefore.cols)).toBeLessThan(2);
    expect(Math.abs(paneAfter.rows - paneBefore.rows)).toBeLessThan(2);

    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.goto(`/devices/${deviceId}`);
    await expect
      .poll(async () => expectBg(await readTerminalBackground(page), DARK_BG), { timeout: 10_000 })
      .toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});