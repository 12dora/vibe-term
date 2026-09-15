import { expect, test } from '@playwright/test';
import { createLocalDevice } from './helpers/device';
import { createTwoWindowSession, ensureCleanSession, tmux } from './helpers/tmux';

// 移动端侧栏（PWA 里的「菜单」抽屉）关掉当前正在显示的窗口：抽屉必须留在原地，
// 主区落到该设备剩下的那个窗口，而不是整张菜单收走 + 跳设备管理页。
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

function panePath(deviceId: string, windowId: string, paneId: string): string {
  return `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`;
}

test('mobile: closing the displayed window keeps the sheet open and moves to the next window', async ({
  page,
  request,
}) => {
  const sessionName = `vibeterm-e2e-close-current-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  expect(windowIds.length).toBe(2);
  expect(paneIds.length).toBe(2);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-close-current-${Date.now()}`);

  try {
    await page.goto(panePath(deviceId, windowIds[0] as string, paneIds[0] as string));
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('mobile-sidebar-open').click();
    const sheet = page.getByTestId('mobile-sidebar-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId(`window-item-${windowIds[0]}`)).toBeVisible();

    // 关的是 URL 点名的那个窗口
    await page.getByTestId(`window-menu-${windowIds[0]}`).click();
    await page.getByTestId(`window-menu-close-${windowIds[0]}`).click();
    const dialog = page.locator('[data-slot="alert-dialog-content"]');
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-slot="alert-dialog-action"]').click();

    await expect(page.getByTestId(`window-item-${windowIds[0]}`)).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(tmux(`list-windows -t ${sessionName} -F '#{window_id}'`).split(/\r?\n/).length).toBe(1);

    // 抽屉仍在，主区落到剩下那个窗口的 pane（不是 /devices）
    await expect(sheet).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe(panePath(deviceId, windowIds[1] as string, paneIds[1] as string));
    await expect(page.getByTestId('devices-page')).toHaveCount(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
