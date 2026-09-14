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

type OverflowHit = {
  tag: string;
  testid: string | null;
  className: string;
  right: number;
  width: number;
};

type ScrollBox = {
  tag: string;
  testid: string | null;
  className: string;
  scrollWidth: number;
  clientWidth: number;
  overflowX: string;
  overflowY: string;
};

type OverflowReport = {
  viewport: number;
  overflowLimit: number;
  tabRight: number;
  docClientWidth: number;
  docScrollWidth: number;
  pageScrollWidth: number;
  pageClientWidth: number;
  settingsScrollWidth: number;
  settingsClientWidth: number;
  leakingScrollBoxes: ScrollBox[];
  overflowingOutsideTableScroll: OverflowHit[];
};

/** 设置页内容区：只应纵向滚动。标签条 / 宽表自己的 overflow-x-auto 不算泄漏。 */
async function measureRelayTabOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const clip = (value: string) => value.slice(0, 140);
    const classOf = (el: Element) =>
      typeof (el as HTMLElement).className === 'string'
        ? clip((el as HTMLElement).className)
        : clip(el.getAttribute('class') ?? '');

    const doc = document.scrollingElement ?? document.documentElement;
    const pageScroller = document.querySelector('.overflow-auto.overscroll-auto');
    const settings = document.querySelector('[data-testid="settings-page"]');
    const settingsRelayTab = document.querySelector('[data-testid="settings-relay-tab"]');
    const settingsRelayTabRect = settingsRelayTab?.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const overflowLimit = Math.min(viewport, settingsRelayTabRect?.right ?? viewport);

    const isPageScroller = (el: Element | null) => el !== null && el === pageScroller;

    const insideIntentionalXScroll = (el: Element): boolean => {
      let current: Element | null = el.parentElement;
      while (current && current !== document.documentElement) {
        if (isPageScroller(current)) return false;
        const ox = getComputedStyle(current).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
        current = current.parentElement;
      }
      return false;
    };

    const overflowingOutsideTableScroll: OverflowHit[] = [];
    const overflowCandidates: Element[] = settingsRelayTab
      ? [settingsRelayTab, ...settingsRelayTab.querySelectorAll('*')]
      : [...document.querySelectorAll('*')];
    for (const el of overflowCandidates) {
      const rect = el.getBoundingClientRect();
      if (rect.right <= overflowLimit + 1) continue;
      if (insideIntentionalXScroll(el)) continue;
      overflowingOutsideTableScroll.push({
        tag: el.tagName,
        testid: el.getAttribute('data-testid'),
        className: classOf(el),
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      });
    }

    const leakingScrollBoxes: ScrollBox[] = [];
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      const ox = style.overflowX;
      const oy = style.overflowY;
      const isYScroll = oy === 'auto' || oy === 'scroll';
      if (!isYScroll) continue;
      if (ox === 'auto' || ox === 'scroll') {
        if (!isPageScroller(el) && el !== doc) continue;
      }
      if (el.scrollWidth > el.clientWidth + 1) {
        leakingScrollBoxes.push({
          tag: el.tagName,
          testid: el.getAttribute('data-testid'),
          className: classOf(el),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          overflowX: ox,
          overflowY: oy,
        });
      }
    }

    overflowingOutsideTableScroll.sort((a, b) => b.right - a.right);
    return {
      viewport,
      overflowLimit: Math.round(overflowLimit * 10) / 10,
      tabRight: Math.round((settingsRelayTabRect?.right ?? 0) * 10) / 10,
      docClientWidth: doc.clientWidth,
      docScrollWidth: doc.scrollWidth,
      pageScrollWidth: pageScroller?.scrollWidth ?? 0,
      pageClientWidth: pageScroller?.clientWidth ?? 0,
      settingsScrollWidth: settings?.scrollWidth ?? 0,
      settingsClientWidth: settings?.clientWidth ?? 0,
      leakingScrollBoxes,
      overflowingOutsideTableScroll: overflowingOutsideTableScroll.slice(0, 20),
    };
  });
}

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

test('relay operator tab does not scroll horizontally at 400/768/1024/1280', async ({ page }) => {
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
  await expect(page.getByTestId('relay-turn')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);

  const widths = [400, 768, 1024, 1280] as const;
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    await expect(page.getByTestId('settings-relay-tab')).toBeVisible();
    const report = await measureRelayTabOverflow(page);
    const detail = JSON.stringify(report, null, 2);
    expect(report.docScrollWidth, `document @${width}\n${detail}`).toBeLessThanOrEqual(
      report.docClientWidth + 1
    );
    expect(report.pageScrollWidth, `page scroller @${width}\n${detail}`).toBeLessThanOrEqual(
      report.pageClientWidth + 1
    );
    expect(report.settingsScrollWidth, `settings-page @${width}\n${detail}`).toBeLessThanOrEqual(
      report.settingsClientWidth + 1
    );
    expect(report.leakingScrollBoxes, `scroll boxes @${width}\n${detail}`).toEqual([]);
    expect(report.overflowingOutsideTableScroll, `overflowing @${width}\n${detail}`).toEqual([]);
    await page.screenshot({
      path: `test-results/r52-relay-tab-${width}.png`,
      animations: 'disabled',
    });
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
