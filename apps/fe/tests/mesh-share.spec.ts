import { type Browser, type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  createDeviceOnNode,
  createRemoteTmuxSession,
  deleteDeviceOnNode,
  killRemoteTmuxSession,
  loginWithPassword,
  meshTmux,
  meshUrl,
  readMeshState,
  readTerminalBuffer,
  signInToNodeFromDevicesPage,
} from './helpers/mesh';

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

interface ShareListBody {
  active: Array<{ id: string; url: string; viewers: number; state: string }>;
  history: Array<{ id: string; endReason: string | null; logBytes: number }>;
}

async function listShares(page: Page, nodeId: string): Promise<ShareListBody> {
  const res = await page.request.get(meshUrl(state, `/n/${nodeId}/api/share`));
  expect(res.ok(), `list shares: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as ShareListBody;
}

async function openRecipient(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('share-password')).toBeVisible({ timeout: 30_000 });
  return page;
}

test('mesh: a shared window is reachable through the hub with only that window visible', async ({
  page,
  browser,
}) => {
  const sessionName = `tmex-mesh-share-${Date.now()}`;
  const marker = `TMEX_SHARE_MARKER_${Date.now()}`;
  createRemoteTmuxSession(state, sessionName);
  let deviceId: string | undefined;
  let recipient: Page | undefined;
  const nodeId = state.remoteNodeId;

  try {
    await loginWithPassword(page, state);
    await signInToNodeFromDevicesPage(page, nodeId);
    deviceId = await createDeviceOnNode(page, state, nodeId, {
      name: sessionName,
      session: sessionName,
    });
    // e2e 里 hub 只有 localhost 地址，预设候选为空；用「默认分享地址」显式指定。
    const settings = await page.request.put(meshUrl(state, `/n/${nodeId}/api/share/settings`), {
      data: { defaultOrigin: state.baseUrl },
    });
    expect(settings.ok(), await settings.text()).toBeTruthy();

    await page.goto(meshUrl(state, `/n/${nodeId}/devices/${deviceId}`), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('device-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('share-open-button').click();
    await expect(page.getByTestId('share-create-form')).toBeVisible({ timeout: 15_000 });
    const password = await page.getByTestId('share-password').inputValue();
    expect(password.length).toBeGreaterThanOrEqual(8);
    await page.getByTestId('share-name').fill('e2e share');
    await page.getByTestId('share-create-submit').click();
    await expect(page.getByTestId('share-active-view')).toBeVisible({ timeout: 15_000 });

    const created = await listShares(page, nodeId);
    expect(created.active).toHaveLength(1);
    const share = created.active[0];
    expect(share.url).toContain(`/n/${nodeId}/s/${share.id}`);

    recipient = await openRecipient(browser, share.url);
    await expect(recipient.getByTestId('share-name')).toHaveText('e2e share');
    await recipient.getByTestId('share-password-input').fill('wrong-password');
    await recipient.getByTestId('share-password-submit').click();
    await expect(recipient.getByTestId('share-password-error')).toBeVisible({ timeout: 10_000 });

    await recipient.getByTestId('share-password-input').fill(password);
    await recipient.getByTestId('share-password-submit').click();
    await expect(recipient.getByTestId('share-header')).toBeVisible({ timeout: 30_000 });
    await expect(recipient.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });
    await expect(recipient.getByTestId('sidebar')).toHaveCount(0);

    await recipient.locator('.xterm').first().click();
    await recipient.keyboard.type(`echo ${marker}`);
    await recipient.keyboard.press('Enter');
    await expect.poll(() => readTerminalBuffer(recipient as Page), { timeout: 30_000 }).toContain(
      marker
    );
    expect(meshTmux(state.nodeTmuxSocket, `capture-pane -p -t ${sessionName}`)).toContain(marker);
    await expect.poll(() => readTerminalBuffer(page), { timeout: 30_000 }).toContain(marker);

    // 分享凭证不能触达常规 API；hub 转发与本机路径都只放行 share-access。
    const statuses = await recipient.evaluate(async (id) => {
      const paths = [`/n/${id}/api/devices`, `/n/${id}/api/mesh/nodes`, '/api/devices'];
      return Promise.all(
        paths.map((path) => fetch(path, { credentials: 'include' }).then((res) => res.status))
      );
    }, nodeId);
    expect(statuses.every((status) => status === 401 || status === 403)).toBe(true);

    await expect
      .poll(async () => (await listShares(page, nodeId)).active[0]?.viewers, { timeout: 15_000 })
      .toBe(1);

    const revoke = await page.request.post(meshUrl(state, `/n/${nodeId}/api/share/${share.id}/revoke`));
    expect(revoke.ok(), await revoke.text()).toBeTruthy();
    await expect(recipient.getByTestId('share-ended')).toBeVisible({ timeout: 10_000 });

    const after = await listShares(page, nodeId);
    expect(after.active).toHaveLength(0);
    expect(after.history[0]?.id).toBe(share.id);
    expect(after.history[0]?.endReason).toBe('revoked');

    const log = await page.request.get(
      meshUrl(state, `/n/${nodeId}/api/share/${share.id}/log?limit=500`)
    );
    expect(log.ok(), await log.text()).toBeTruthy();
    const entries = ((await log.json()) as { entries: Array<{ kind: string; data: string }> })
      .entries;
    const kinds = new Set(entries.map((entry) => entry.kind));
    expect(kinds.has('checkpoint')).toBe(true);
    expect(kinds.has('in')).toBe(true);
    expect(kinds.has('out')).toBe(true);
    const typed = entries
      .filter((entry) => entry.kind === 'in')
      .map((entry) => Buffer.from(entry.data, 'base64').toString('utf8'))
      .join('');
    expect(typed).toContain(marker);

    // 已结束的分享直接显示结束页，不再要口令。
    const reopened = await (await browser.newContext()).newPage();
    await reopened.goto(share.url, { waitUntil: 'domcontentloaded' });
    await expect(reopened.getByTestId('share-ended')).toBeVisible({ timeout: 30_000 });
    await reopened.context().close();
    const info = await page.request.get(meshUrl(state, `/n/${nodeId}/api/share-access/${share.id}`));
    expect(((await info.json()) as { state: string }).state).toBe('ended');
  } finally {
    await recipient?.context().close();
    if (deviceId) await deleteDeviceOnNode(page, state, nodeId, deviceId);
    killRemoteTmuxSession(state, sessionName);
  }
});
