import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { createSinglePaneSession, ensureCleanSession, getPaneSize } from './helpers/tmux';

// 多客户端视口策略：最大可见客户端持有整窗尺寸；小客户端跟随权威几何并本地平移。

async function readTerminalSize(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return { cols: term.cols, rows: term.rows };
  });
}

async function readPanState(page: Page): Promise<{ enabled: boolean; overflowX: number } | null> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.xterm-viewport');
    if (!viewport) return null;
    return {
      enabled: viewport.dataset.panViewport === 'true',
      overflowX: Math.max(0, viewport.scrollWidth - viewport.clientWidth),
    };
  });
}

async function matchState(page: Page, paneId: string): Promise<string> {
  const term = await readTerminalSize(page);
  const pane = getPaneSize(paneId);
  if (!term) return 'terminal-unavailable';
  const t = `${term.cols}x${term.rows}`;
  const p = `${pane.cols}x${pane.rows}`;
  return t === p ? 'match' : `terminal=${t};pane=${p}`;
}

async function setDocumentHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (isHidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function openTwoClients(browser: Browser, deviceId: string) {
  const contextA: BrowserContext = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const contextB: BrowserContext = await browser.newContext({
    viewport: { width: 640, height: 480 },
  });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await pageA.goto(`/devices/${deviceId}`);
  await expect(pageA.getByTestId('device-page')).toBeVisible();
  await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
  await pageB.goto(`/devices/${deviceId}`);
  await expect(pageB.getByTestId('device-page')).toBeVisible();
  await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
  return { contextA, contextB, pageA, pageB };
}

async function createDevice(request: any, sessionName: string): Promise<string> {
  const res = await request.post('/api/devices', {
    data: {
      name: `e2e-viewport-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(res.ok()).toBeTruthy();
  const created = (await res.json()) as { device: { id: string } };
  return created.device.id;
}

test('viewport-policy: a smaller second client does not shrink the tmux window and pans locally', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-viewport-${Date.now()}`;
  const { paneId } = createSinglePaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName);
  let clients: Awaited<ReturnType<typeof openTwoClients>> | null = null;

  try {
    clients = await openTwoClients(browser, deviceId);
    const { pageA, pageB } = clients;

    // 大客户端 A 是 owner：整窗与 A 的本地几何一致
    await expect.poll(() => matchState(pageA, paneId), { timeout: 20_000 }).toBe('match');
    const sizeA = (await readTerminalSize(pageA))!;

    // 小客户端 B 打开后整窗不得缩小；B 的模拟器跟随权威几何并进入平移视口
    await pageB.waitForTimeout(1_500);
    expect(getPaneSize(paneId)).toEqual(sizeA);
    // 先确认 B 已知自己是 follower（平移视口打开），再看本地几何是否收敛到权威尺寸
    await expect
      .poll(async () => (await readPanState(pageB))?.enabled ?? null, { timeout: 10_000 })
      .toBe(true);
    await expect.poll(() => matchState(pageB, paneId), { timeout: 20_000 }).toBe('match');
    const pan = (await readPanState(pageB))!;
    expect(pan.overflowX).toBeGreaterThan(0);

    // A 隐藏（切到后台）→ B 成为 owner，整窗收敛到 B 的容器尺寸，平移关闭
    await setDocumentHidden(pageA, true);
    await expect
      .poll(async () => (await readPanState(pageB))?.enabled ?? null, { timeout: 10_000 })
      .toBe(false);
    await expect.poll(() => matchState(pageB, paneId), { timeout: 20_000 }).toBe('match');
    const sizeB = (await readTerminalSize(pageB))!;
    expect(sizeB.cols).toBeLessThan(sizeA.cols);

    // A 回到前台 → 重新成为 owner
    await setDocumentHidden(pageA, false);
    await expect.poll(() => getPaneSize(paneId).cols, { timeout: 20_000 }).toBe(sizeA.cols);
    await expect
      .poll(async () => (await readPanState(pageB))?.enabled ?? null, { timeout: 10_000 })
      .toBe(true);
  } finally {
    await clients?.contextA.close();
    await clients?.contextB.close();
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('viewport-policy: closing the owner hands the window size to the remaining client', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-viewport-close-${Date.now()}`;
  const { paneId } = createSinglePaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName);
  let clients: Awaited<ReturnType<typeof openTwoClients>> | null = null;

  try {
    clients = await openTwoClients(browser, deviceId);
    const { contextA, pageA, pageB } = clients;
    await expect.poll(() => matchState(pageA, paneId), { timeout: 20_000 }).toBe('match');
    const sizeA = (await readTerminalSize(pageA))!;
    await expect
      .poll(async () => (await readPanState(pageB))?.enabled ?? null, { timeout: 10_000 })
      .toBe(true);

    await contextA.close();

    await expect
      .poll(async () => (await readPanState(pageB))?.enabled ?? null, { timeout: 10_000 })
      .toBe(false);
    await expect.poll(() => matchState(pageB, paneId), { timeout: 20_000 }).toBe('match');
    expect(getPaneSize(paneId).cols).toBeLessThan(sizeA.cols);
  } finally {
    await clients?.contextB.close();
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
