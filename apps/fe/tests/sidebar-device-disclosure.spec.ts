import { expect, test } from '@playwright/test';
import { decodePaneIdFromUrlParam } from '@tmex/stores';
import { matchPath } from 'react-router';
import { createLocalDevice } from './helpers/device';
import { createSinglePaneSession, createTwoPaneSession, ensureCleanSession } from './helpers/tmux';

test('sidebar: device disclosure persists and tabs stay mutually exclusive', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-sidebar-disclosure-${Date.now()}`;
  const { paneIds, windowId } = createTwoPaneSession(sessionName);
  const selectedPaneId = paneIds[0] as string;
  let deviceId: string | undefined;
  let offlineDeviceId: string | undefined;

  try {
    const createRes = await request.post('/api/devices', {
      data: {
        name: `e2e-sidebar-disclosure-${Date.now()}`,
        type: 'local',
        session: sessionName,
        authMode: 'auto',
      },
    });
    expect(createRes.ok()).toBeTruthy();
    deviceId = ((await createRes.json()) as { device: { id: string } }).device.id;

    const offlineCreateRes = await request.post('/api/devices', {
      data: {
        name: `e2e-sidebar-offline-${Date.now()}`,
        type: 'ssh',
        host: '127.0.0.1',
        port: 1,
        username: 'tmex-e2e',
        session: `${sessionName}-missing`,
        authMode: 'password',
        password: 'tmex-e2e-unreachable',
      },
    });
    expect(offlineCreateRes.ok()).toBeTruthy();
    offlineDeviceId = ((await offlineCreateRes.json()) as { device: { id: string } }).device.id;

    await page.goto('/devices');
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(page.getByTestId('devices-page')).toBeVisible();
    await expect(
      page.locator(`[data-testid="device-card"][data-device-id="${deviceId}"]`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="device-card"][data-device-id="${offlineDeviceId}"]`)
    ).toBeVisible();

    // 侧边栏三 Tab 互斥，默认 Panes；只有当前 Tab 的内容被挂载
    const panesTab = page.getByTestId('sidebar-tab-panes');
    const agentTab = page.getByTestId('sidebar-tab-agent');
    const filesTab = page.getByTestId('sidebar-tab-files');
    await expect(panesTab).toHaveAttribute('aria-selected', 'true');
    await expect(agentTab).toHaveAttribute('aria-selected', 'false');
    await expect(filesTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId(`device-item-${deviceId}`)).toBeVisible();

    await filesTab.click();
    await expect(filesTab).toHaveAttribute('aria-selected', 'true');
    await expect(panesTab).toHaveAttribute('aria-selected', 'false');
    await expect(agentTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByTestId('files-tab')).toBeVisible();
    await expect(page.getByTestId(`device-item-${deviceId}`)).toHaveCount(0);

    // Tab 选择不持久化：刷新后回到默认的 Panes
    await page.reload();
    await expect(panesTab).toHaveAttribute('aria-selected', 'true');
    await expect(agentTab).toHaveAttribute('aria-selected', 'false');
    await expect(filesTab).toHaveAttribute('aria-selected', 'false');

    const deviceToggle = page.getByTestId(`device-expand-${deviceId}`);
    await expect(deviceToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId(`window-item-${windowId}`)).toBeVisible({ timeout: 20_000 });
    const deviceStatus = page.getByTestId(`device-online-status-${deviceId}`);
    await expect(deviceStatus).toHaveAttribute('data-online', 'true', { timeout: 20_000 });
    await expect(
      page.getByTestId(`device-item-${offlineDeviceId}`).locator('[data-slot="badge"]')
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId(`device-online-status-${offlineDeviceId}`)).toHaveAttribute(
      'data-online',
      'false',
      { timeout: 20_000 }
    );
    const arrowBox = await deviceToggle.boundingBox();
    const statusBox = await deviceStatus.boundingBox();
    if (!arrowBox || !statusBox) {
      throw new Error('Expected device status and disclosure controls to have layout boxes');
    }
    expect(arrowBox.x).toBeGreaterThan(statusBox.x);
    const deviceTree = page.getByTestId(`device-tree-${deviceId}`);
    await expect(deviceTree).toBeVisible();
    const treePaddingLeft = await deviceTree.evaluate((node) =>
      Number.parseFloat(getComputedStyle(node).paddingLeft)
    );
    expect(treePaddingLeft).toBeGreaterThanOrEqual(20);

    await deviceToggle.click();
    await expect(page.getByTestId(`window-item-${windowId}`)).toHaveCount(0);
    await page.reload();
    await expect(deviceToggle).toHaveAttribute('aria-expanded', 'false');

    await deviceToggle.click();
    await page.goto(
      `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(selectedPaneId)}`
    );
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    const currentRoute = matchPath(
      '/devices/:deviceId/windows/:windowId/panes/:paneId',
      new URL(page.url()).pathname
    );
    expect(currentRoute).not.toBeNull();
    const currentWindowId = currentRoute?.params.windowId as string;
    const currentPaneId = decodePaneIdFromUrlParam(
      decodeURIComponent(currentRoute?.params.paneId as string)
    ) as string;

    await expect(page.getByTestId(`window-item-${currentWindowId}`)).toHaveAttribute(
      'data-active',
      'true'
    );
    await expect(page.getByTestId(`pane-item-${currentPaneId}`)).toHaveAttribute(
      'data-active',
      'true'
    );
    await expect(page.locator('[data-testid^="pane-item-"][data-active="true"]')).toHaveCount(1);

    await deviceToggle.click();
    await expect(deviceToggle).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(deviceToggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    if (deviceId) {
      await request.delete(`/api/devices/${deviceId}`).catch(() => undefined);
    }
    if (offlineDeviceId) {
      await request.delete(`/api/devices/${offlineDeviceId}`).catch(() => undefined);
    }
    ensureCleanSession(sessionName);
  }
});
