// 多节点通知（汇聚）e2e：入口机（hub）声明为汇聚点后，远端 node 上触发的 watch 事件
// 要在**入口机这一页**弹出 toast，并点名来源节点。
//
// 两页并存是刻意的：远端设备要连上才有 watch 采样，那一页停在 `/n/<B>/...`；
// 入口那一页全程停在本机路由（`/settings`），toast 若出现就只能来自入口自身的连接。

import { type Page, expect, test } from '@playwright/test';
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
  signInToNodeFromDevicesPage,
} from './helpers/mesh';

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

interface MeshNotifyBody {
  supported: boolean;
  selfEnabled: boolean;
  sinks: Array<{ nodeId: string; name: string; self: boolean; online: boolean }>;
}

async function meshNotifyState(page: Page, nodeId: string | null): Promise<MeshNotifyBody> {
  const path = nodeId ? `/n/${nodeId}/api/notifications/mesh` : '/api/notifications/mesh';
  const res = await page.request.get(meshUrl(state, path));
  expect(res.ok(), `mesh notify state: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as MeshNotifyBody;
}

test('mesh: the sink toasts events forwarded from another node', async ({ page, context }) => {
  const sessionName = `tmex-mesh-notify-${Date.now()}`;
  const token = `TMEX_MESH_NOTIFY_${Date.now()}`;
  createRemoteTmuxSession(state, sessionName);
  const paneId = meshTmux(state.nodeTmuxSocket, `list-panes -t ${sessionName}:0 -F '#{pane_id}'`);
  const windowId = meshTmux(
    state.nodeTmuxSocket,
    `display-message -p -t ${sessionName}:0 '#{window_id}'`
  );

  let deviceId: string | undefined;
  let ruleId: string | undefined;
  let nodePage: Page | undefined;
  const nodeId = state.remoteNodeId;

  try {
    await loginWithPassword(page, state);
    await signInToNodeFromDevicesPage(page, nodeId);
    deviceId = await createDeviceOnNode(page, state, nodeId, {
      name: sessionName,
      session: sessionName,
    });

    // 入口机（hub）在「设置 → 通知」里声明为汇聚点。
    await page.goto(meshUrl(state, '/settings?tab=notifications'), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('settings-notify-scope-banner')).toBeVisible({ timeout: 30_000 });
    const card = page.getByTestId('settings-mesh-notify-card');
    await expect(card).toBeVisible({ timeout: 30_000 });

    const toggle = page.getByTestId('settings-mesh-notify-switch');
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 });
    await expect(page.getByTestId('settings-mesh-notify-sinks')).toBeVisible();

    // 声明经 mesh 广播出去：入口自己与远端 node 都要看得到这台汇聚机。
    await expect
      .poll(async () => (await meshNotifyState(page, null)).selfEnabled, { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await meshNotifyState(page, nodeId)).sinks.some(
            (sink) => sink.nodeId === state.hubNodeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true);

    // 远端 node 上建一条 match 规则。
    const ruleRes = await page.request.post(meshUrl(state, `/n/${nodeId}/api/watch/rules`), {
      data: {
        name: `mesh-notify-${Date.now()}`,
        deviceId,
        paneId,
        triggerType: 'match',
        pattern: token,
        intervalSeconds: 5,
        fireMode: 'once',
      },
    });
    expect(
      ruleRes.ok(),
      `create watch rule: ${ruleRes.status()} ${await ruleRes.text()}`
    ).toBeTruthy();
    ruleId = ((await ruleRes.json()) as { rule: { id: string } }).rule.id;

    // 另开一页把远端设备连上（watch 采样要有活着的 tmux 连接），入口那一页不动。
    nodePage = await context.newPage();
    await nodePage.goto(
      meshUrl(
        state,
        `/n/${nodeId}/devices/${deviceId}/windows/${encodeURIComponent(
          windowId
        )}/panes/${encodeURIComponent(paneId)}`
      ),
      { waitUntil: 'domcontentloaded' }
    );
    await expect(nodePage.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });

    // 入口那一页仍停在本机路由：这一条断言是整个用例的前提。
    expect(new URL(page.url()).pathname).toBe('/settings');

    meshTmux(state.nodeTmuxSocket, `send-keys -t ${paneId} "echo ${token}" Enter`);

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: state.remoteNodeName });
    await expect(toast).toBeVisible({ timeout: 60_000 });
  } finally {
    await nodePage?.close();
    if (ruleId) {
      await page.request
        .delete(meshUrl(state, `/n/${nodeId}/api/watch/rules/${ruleId}`))
        .catch(() => undefined);
    }
    if (deviceId) await deleteDeviceOnNode(page, state, nodeId, deviceId);
    await page.request
      .put(meshUrl(state, '/api/notifications/mesh'), { data: { enabled: false } })
      .catch(() => undefined);
    killRemoteTmuxSession(state, sessionName);
  }
});
