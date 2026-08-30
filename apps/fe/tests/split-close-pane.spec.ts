import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import {
  createFourPaneSession,
  createTwoPaneSession,
  ensureCleanSession,
  tmux,
} from './helpers/tmux';

// 分屏里关闭当前焦点 pane：URL 必须先落到幸存 pane 再发 close-pane，
// 否则 kill 到新快照回来的这段时间 URL 指向已删除的 pane，中心会出现「连接设备中」遮罩。

test.use({ viewport: { width: 1280, height: 800 } });

async function createDevice(
  request: APIRequestContext,
  sessionName: string,
  name: string
): Promise<string> {
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  return created.device.id;
}

function routedPaneId(page: Page): string {
  const match = decodeURIComponent(new URL(page.url()).pathname).match(/\/panes\/(.+)$/);
  return match?.[1] ?? '';
}

function livePaneIds(sessionName: string): string[] {
  return tmux(`list-panes -s -t ${sessionName} -F '#{pane_id}'`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function waitForSplitPanes(page: Page, expectedPanes: number): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.getByTestId('split-terminal-area')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('split-pane')).toHaveCount(expectedPanes, { timeout: 20_000 });
  await expect(page.locator('[data-terminal-engine] canvas').first()).toBeAttached({
    timeout: 20_000,
  });
}

/** 关闭后的一段时间里遮罩一次都不应出现（出现即说明 URL 仍指向已删除的 pane） */
async function expectNoResolvingOverlay(page: Page, durationMs: number): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect(await page.getByTestId('terminal-status-overlay').count()).toBe(0);
    await page.waitForTimeout(100);
  }
}

test('desktop: closing the focused pane from the split view moves the route to a survivor', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-split-close-${Date.now()}`;
  createFourPaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName, `e2e-split-close-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForSplitPanes(page, 4);

    const closingPaneId = routedPaneId(page);
    expect(closingPaneId).not.toBe('');

    await page.getByTestId(`split-pane-close-${closingPaneId}`).click();

    // 路由立刻改写到幸存 pane，全程不出现「连接设备中」遮罩
    await expect.poll(() => routedPaneId(page), { timeout: 5_000 }).not.toBe(closingPaneId);
    await expectNoResolvingOverlay(page, 3_000);

    await expect.poll(() => livePaneIds(sessionName).length, { timeout: 15_000 }).toBe(3);
    await expect(page.getByTestId('split-pane')).toHaveCount(3, { timeout: 15_000 });
    expect(livePaneIds(sessionName)).toContain(routedPaneId(page));
    await expect(
      page.locator(`[data-testid="split-pane"][data-focused][data-pane-id="${routedPaneId(page)}"]`)
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: closing one of two panes leaves the survivor mounted without a connecting overlay', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-split-close-last-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const deviceId = await createDevice(request, sessionName, `e2e-split-close-last-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForSplitPanes(page, 2);

    const closingPaneId = routedPaneId(page);
    const survivor = paneIds.find((id) => id !== closingPaneId);
    expect(survivor).toBeDefined();

    await page.getByTestId(`split-pane-close-${closingPaneId}`).click();

    await expect.poll(() => routedPaneId(page), { timeout: 5_000 }).toBe(survivor);
    await expectNoResolvingOverlay(page, 3_000);

    // 剩一个 pane 时退出分屏，幸存 pane 以单终端挂载
    await expect(page.getByTestId('split-terminal-area')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-terminal-engine] canvas').first()).toBeAttached({
      timeout: 20_000,
    });
    expect(livePaneIds(sessionName)).toEqual([survivor as string]);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
