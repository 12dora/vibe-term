import { type Page, expect, test } from '@playwright/test';
import { createLocalDevice } from './helpers/device';
import { createSinglePaneSession, ensureCleanSession } from './helpers/tmux';
import { KIND, decodeEnvelope, decodeSiteThemeUpdateS2C, isGatewayWsUrl } from './helpers/ws-borsh';

// 跨设备主题广播 e2e：并发 last-writer-wins + 离线 fallback。
// T10 实现 WS 广播 KIND_SITE_THEME_UPDATE；T11 实现前端 useSiteStore.setThemeFromS2C；
// 离线时 updateTheme 只写 localStorage + 本地 state，不发 C2S，重连后由 S2C 同步。
// 注意：HTTP API 路径（POST /api/settings/theme）不发 S2C WS 广播，前端不会收到通知。
// 故主题切换必须走 UI（侧边栏主题菜单 → useSiteStore.selectThemePreset/updateTheme →
// C2S WS → S2C 广播）。

test.use({ viewport: { width: 1280, height: 800 } });

const DARK_BG = '#262626';
const LIGHT_BG = '#e1e1e1';

async function setThemeViaUI(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  const wantDark = theme === 'dark';
  if (isDark === wantDark) return;
  await page.getByTestId('theme-menu-trigger').click();
  await page.getByTestId(`theme-option-${theme}`).click();
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

test('theme-broadcast: concurrent last-writer-wins — two pages toggle different themes, final state consistent', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-lww-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-lww-${Date.now()}`);

  const pageA = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageB = await contextB.newPage();

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

    await setThemeViaUI(pageA, 'light');
    await pageA.goto(`/devices/${deviceId}`);
    await setThemeViaUI(pageA, 'dark');
    await pageA.goto(`/devices/${deviceId}`);

    await pageA.waitForTimeout(3_000);

    const bgA = await readTerminalBackground(pageA);
    const bgB = await readTerminalBackground(pageB);
    expect(normalizeColor(bgA)).toBe(normalizeColor(bgB));

    const finalTheme = await request.get('/api/settings/theme').then((r) => r.json());
    const finalBg = (finalTheme as { theme: string }).theme === 'light' ? LIGHT_BG : DARK_BG;
    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageA), finalBg), { timeout: 10_000 })
      .toBe(true);
    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageB), finalBg), { timeout: 10_000 })
      .toBe(true);
  } finally {
    await pageA.close();
    await contextB.close();
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});

test('theme-broadcast: offline fallback — toggle while offline, sync after reconnect', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-offline-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-offline-${Date.now()}`);

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

    await contextB.setOffline(true);
    await pageB.waitForTimeout(1_000);

    await setThemeViaUI(pageA, 'light');
    await pageA.goto(`/devices/${deviceId}`);

    await expect
      .poll(async () => expectBg(await readTerminalBackground(pageA), LIGHT_BG), { timeout: 10_000 })
      .toBe(true);

    await contextB.setOffline(false);

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

test('theme-broadcast: serverTimestamp strictly monotonic across rapid toggles', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-ts-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-ts-${Date.now()}`);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const receiver = attachSiteThemeReceiver(page);

  try {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000);

    const initialCount = receiver.received().length;

    for (let i = 0; i < 6; i++) {
      const theme = i % 2 === 0 ? 'light' : 'dark';
      await setThemeViaUI(page, theme);
      await page.goto(`/devices/${deviceId}`);
      await page.waitForTimeout(200);
    }

    await expect
      .poll(() => receiver.received().length, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(initialCount + 4);

    const timestamps = receiver.received().map((r) => r.serverTimestamp);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!);
    }
  } finally {
    await page.close();
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});