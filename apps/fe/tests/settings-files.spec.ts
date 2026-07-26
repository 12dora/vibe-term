import { expect, test } from '@playwright/test';

test('settings files roots query does not reuse the sidebar file tree cache shape', async ({ page }) => {
  await page.route('**/api/files/roots', async (route) => {
    await route.fulfill({ status: 200, json: { roots: [] } });
  });

  await page.goto('/settings');
  await page.getByTestId('settings-tab-devicesAndFiles').click();

  await expect(page.getByTestId('settings-files-section')).toBeVisible();
  await expect(page.getByTestId('settings-files-empty')).toBeVisible();
});
