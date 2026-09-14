import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  loginWithPassword,
  meshStatePath,
  meshUrl,
  readMeshState,
} from './helpers/mesh-e2e';

test.use({ locale: 'zh-CN' });

const SITE_LANGUAGE_CACHE_KEY = 'vibeterm.site.language';

let state: MeshState;
let raw: {
  relay: { port: number; username: string; password: string };
};

test.beforeAll(() => {
  state = readMeshState();
  raw = JSON.parse(readFileSync(meshStatePath(), 'utf8'));
});

/** 首屏语言走站点语言缓存（`vibeterm.site.language`），再叠加 Playwright locale。 */
async function pinCachedZhCN(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    localStorage.setItem(key, 'zh_CN');
  }, SITE_LANGUAGE_CACHE_KEY);
}

/** 登录后 PATCH `/api/settings/site` 的 `language` 字段，避免 store 用服务端 en_US 盖掉。 */
async function persistSiteLanguageZhCN(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const res = await fetch('/api/settings/site', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'zh_CN' }),
    });
    return res.status;
  });
  expect(status).toBeLessThan(300);
}

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}\n${err.stack ?? ''}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('404'))
      errors.push(`console: ${msg.text()}`);
  });
  return errors;
}

async function openNodesTab(page: Page, base: string, errors: string[]): Promise<void> {
  await page.goto(`${base}/settings?tab=nodes`, { waitUntil: 'domcontentloaded' });
  const card = page.getByTestId('local-machine-card');
  try {
    await expect(card).toBeVisible({ timeout: 30_000 });
  } catch (error) {
    const details = page.getByText('Technical details');
    if (await details.count()) {
      await details.click();
      await page.waitForTimeout(300);
      errors.push(`details: ${await page.locator('body').innerText()}`);
    }
    throw new Error(`settings did not render:\n${errors.join('\n----\n')}`, { cause: error });
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await page.waitForTimeout(800);
}

test('shots: local card relay panel, connection details and 更多 tooltip on node A', async ({
  page,
}) => {
  const errors = captureErrors(page);
  await pinCachedZhCN(page);
  await loginWithPassword(page, state);
  await persistSiteLanguageZhCN(page);
  await openNodesTab(page, meshUrl(state, '').replace(/\/$/, ''), errors);
  await page.getByTestId('local-machine-details-toggle').click();
  await expect(page.getByTestId('local-machine-details-content')).toBeVisible();
  await page.getByTestId('local-machine-card').screenshot({
    path: 'test-results/r51-local-card.png',
  });
  const more = page.locator('[data-testid^="nodes-relay-more-"]').first();
  if (await more.count()) {
    await more.hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/r51-local-card-more.png' });
  }
  const text = await page.getByTestId('local-machine-card').innerText();
  expect(text).toContain('中继');
  const rtt = page.locator('[data-testid^="nodes-relay-rtt-"]');
  if (await rtt.count()) {
    expect(await rtt.first().innerText()).toContain('延迟');
  }
  expect(text).not.toContain('上级');
  expect(text).not.toContain('打分');
  expect(text).not.toContain('成员可达');
  await expect(page.getByTestId('nodes-relay-enroll-password')).toBeVisible();
});

test('shots: relay operator TURN tile on the relay host', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = captureErrors(page);
  await pinCachedZhCN(page);
  const base = `http://localhost:${raw.relay.port}`;
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('login-username').fill(raw.relay.username);
  await page.getByTestId('login-password').fill(raw.relay.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 90_000 });
  await persistSiteLanguageZhCN(page);
  await page.goto(`${base}/settings?tab=relay`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-relay-tab')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByTestId('relay-turn')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.getByTestId('relay-turn').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/r51-relay-operator.png', animations: 'disabled' });
  const operatorText = await page.getByTestId('settings-relay-tab').innerText();
  expect(operatorText).toContain('内网穿透');
  expect(operatorText).toContain('TURN 服务器');
  expect(operatorText).toContain('需放行 UDP');
  expect(operatorText).not.toContain('安全组');
  expect(operatorText).not.toContain('成员可达');
  await expect(page.getByTestId('relay-metric-turn')).toContainText(/allocations|分配/);
  await expect(page.getByTestId('relay-turn-firewall')).toContainText(/UDP 40000/);
  await openNodesTab(page, base, errors);
  await page.getByTestId('local-machine-card').screenshot({
    path: 'test-results/r51-relay-host-local-card.png',
  });
});
