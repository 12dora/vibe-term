import { expect, test } from '@playwright/test';
import { type MeshState, loginWithPassword, meshUrl, readMeshState } from './helpers/mesh-e2e';

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

test('mesh: the local machine card menu offers only relay roles, never Hub', async ({ page }) => {
  await loginWithPassword(page, state);
  await page.goto(meshUrl(state, '/settings?tab=nodes'), { waitUntil: 'domcontentloaded' });
  const role = page.getByTestId('local-machine-role');
  await expect(role).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('local-machine-menu').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const text = await menu.innerText();
  await page.screenshot({ path: 'test-results/local-card-menu.png', fullPage: false });
  expect(text).not.toMatch(/hub/i);
  expect(text).not.toContain('Hub');
  for (const target of ['relay', 'relay,node']) {
    await expect(page.getByTestId(`local-machine-role-${target}`)).toBeVisible();
  }
  await expect(page.getByTestId('local-machine-role-hub,node')).toHaveCount(0);
  const pageText = await page.locator('body').innerText();
  expect(pageText).not.toMatch(/\bHub\b/);
});
