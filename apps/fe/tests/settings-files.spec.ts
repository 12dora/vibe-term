import { expect, test } from '@playwright/test';
import { createLocalDevice } from './helpers/device';

// 目录配置的唯一入口是「管理设备」→ 设备卡片 ⋯ →「文件」（设置页已无「设备与文件」标签）。
test('device files modal roots query does not reuse the sidebar file tree cache shape', async ({
  page,
  request,
}) => {
  const deviceId = await createLocalDevice(request, `e2e-files-${Date.now()}`);

  await page.route('**/api/files/roots', async (route) => {
    await route.fulfill({ status: 200, json: { roots: [] } });
  });

  await page.goto('/devices');
  await expect(page.getByTestId('devices-page')).toBeVisible();

  const card = page.locator(`[data-testid="device-card"][data-device-id="${deviceId}"]`);
  await expect(card).toBeVisible();
  await card.locator(`[data-testid="device-card-actions-${deviceId}"]`).click();
  await page.getByTestId(`device-card-files-${deviceId}`).click();

  await expect(page.getByTestId(`device-files-modal-${deviceId}`)).toBeVisible();
  await expect(page.getByTestId('settings-files-section')).toBeVisible();
  await expect(page.getByTestId('settings-files-empty')).toBeVisible();
});
