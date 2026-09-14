import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  loginWithPassword,
  meshStatePath,
  meshUrl,
  readMeshState,
} from './helpers/mesh-e2e';

let state: MeshState;
let raw: {
  relay: { port: number; username: string; password: string; relayPassword?: string };
};

test.beforeAll(() => {
  state = readMeshState();
  raw = JSON.parse(readFileSync(meshStatePath(), 'utf8'));
});

async function openNodesTab(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/settings?tab=nodes`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('local-machine-card')).toBeVisible({ timeout: 30_000 });
}

test('shots: local card relay panel, connection details and 更多 tooltip on node A', async ({
  page,
}) => {
  await loginWithPassword(page, state);
  await openNodesTab(page, meshUrl(state, ''));
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
  expect(text).not.toContain('上级');
  expect(text).not.toContain('打分');
  expect(text).not.toContain('主中继');
  expect(text).not.toContain('副中继');
});

test('shots: relay operator TURN tile on the relay host', async ({ page }) => {
  const base = `http://localhost:${raw.relay.port}`;
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('login-username').fill(raw.relay.username);
  await page.getByTestId('login-password').fill(raw.relay.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 90_000 });
  await page.goto(`${base}/settings?tab=relay`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-relay-tab')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('relay-turn')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('settings-relay-tab').screenshot({
    path: 'test-results/r51-relay-operator.png',
  });
  await openNodesTab(page, base);
  await page.getByTestId('local-machine-card').screenshot({
    path: 'test-results/r51-relay-host-local-card.png',
  });
  const text = await page
    .getByTestId('settings-relay-tab')
    .innerText()
    .catch(() => '');
  expect(text).not.toContain('安全组');
  expect(text).not.toContain('成员可达');
});
