import { type Page, expect, test } from '@playwright/test';
import { createLocalDevice } from './helpers/device';
import { createSinglePaneSession, ensureCleanSession } from './helpers/tmux';

// 命名主题预设 e2e：侧栏主题菜单选中预设后，根节点 data-theme-preset / .dark、页面 token
// （body 背景取 var(--background)）与终端配色应同时切换，刷新后仍在；选回默认 Light/Dark
// 则清掉预设。预设本身只存 localStorage，但它自带的外观走 updateTheme 同步到服务端，
// 故收尾要把站点外观复位成 dark。

test.use({ viewport: { width: 1280, height: 800 } });

// seoul256 默认深色的终端底色（无预设时的基线）
const DEFAULT_TERMINAL_DARK_BG = '#262626';
const DRACULA_BG = '#282a36';
const SOLARIZED_LIGHT_BG = '#fdf6e3';

async function selectThemeOption(page: Page, optionId: string): Promise<void> {
  await page.getByTestId('theme-menu-trigger').click();
  await page.getByTestId(`theme-option-${optionId}`).click();
}

function normalizeColor(raw: string | null): string {
  if (!raw) return '';
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(raw);
  if (!m) return raw.toLowerCase();
  const toHex = (value: string | undefined) =>
    Number(value ?? 0)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
}

async function readTerminalBackground(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-terminal-engine]') as HTMLElement | null;
    if (!el) return null;
    return el.style.backgroundColor || el.style.background || null;
  });
}

async function readBodyBackground(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test('theme-presets: Dracula 同时换 UI token 与终端配色，刷新后保持', async ({ page, request }) => {
  const sessionName = `tmex-e2e-theme-preset-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-theme-preset-${Date.now()}`);
  const html = page.locator('html');
  const trigger = page.getByTestId('theme-menu-trigger');

  try {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(async () => normalizeColor(await readTerminalBackground(page)), { timeout: 15_000 })
      .toBe(DEFAULT_TERMINAL_DARK_BG);

    await selectThemeOption(page, 'dracula');

    await expect(html).toHaveAttribute('data-theme-preset', 'dracula');
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(trigger).toHaveAttribute('data-theme-appearance', 'dark');
    await expect
      .poll(async () => normalizeColor(await readBodyBackground(page)), { timeout: 10_000 })
      .toBe(DRACULA_BG);
    await expect
      .poll(async () => normalizeColor(await readTerminalBackground(page)), { timeout: 10_000 })
      .toBe(DRACULA_BG);

    await page.reload();
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(html).toHaveAttribute('data-theme-preset', 'dracula');
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => normalizeColor(await readTerminalBackground(page)), { timeout: 15_000 })
      .toBe(DRACULA_BG);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
  }
});

test('theme-presets: 浅色预设去掉 .dark，选回 Dark 清空预设', async ({ page, request }) => {
  const html = page.locator('html');
  const trigger = page.getByTestId('theme-menu-trigger');

  try {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await page.goto('/settings');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(html).toHaveClass(/\bdark\b/);

    await selectThemeOption(page, 'solarized-light');

    await expect(html).toHaveAttribute('data-theme-preset', 'solarized-light');
    await expect(html).not.toHaveClass(/\bdark\b/);
    await expect(trigger).toHaveAttribute('data-theme-appearance', 'light');
    await expect
      .poll(async () => normalizeColor(await readBodyBackground(page)), { timeout: 10_000 })
      .toBe(SOLARIZED_LIGHT_BG);

    await selectThemeOption(page, 'dark');

    await expect(html).not.toHaveAttribute('data-theme-preset', /.*/);
    await expect(html).toHaveClass(/\bdark\b/);
    await expect(trigger).toHaveAttribute('data-theme-preset', '');
    await expect(trigger).toHaveAttribute('data-theme-appearance', 'dark');
    await expect
      .poll(async () => normalizeColor(await readBodyBackground(page)), { timeout: 10_000 })
      .not.toBe(SOLARIZED_LIGHT_BG);
  } finally {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
  }
});
