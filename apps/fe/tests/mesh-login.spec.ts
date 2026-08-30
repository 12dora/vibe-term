import { expect, test } from '@playwright/test';
import { sidebarDeviceVisibilityKey } from '@tmex/stores';
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
} from './helpers/mesh';

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

test('mesh: sidebar shows the hub self node; other nodes only once a device is enabled', async ({
  page,
}) => {
  await loginWithPassword(page, state);

  const nodeList = page.getByTestId('sidebar-node-list');
  await expect(nodeList).toBeVisible({ timeout: 30_000 });

  // entry（hub）在侧边栏用 `self` 作为 runtime node id，远端 node 用真实 node id。
  await expect(page.getByTestId('sidebar-node-header-self')).toBeVisible();
  // 远端 node 的设备缺省不在侧边栏显示，整节（含登录入口）都不出现——登录别的节点走「管理设备」。
  await expect(page.getByTestId(`sidebar-node-header-${state.remoteNodeId}`)).toHaveCount(0);

  // 侧边栏渲染的成员集就是 entry 的 /api/mesh/nodes：两台、远端在线且已完成 fan-out 登录。
  const nodes = await page.evaluate(() =>
    fetch('/api/mesh/nodes', { credentials: 'include' })
      .then((res) => res.json())
      .then((body: { nodes: { id: string; online: boolean; loggedIn: boolean }[] }) => body.nodes)
  );
  expect(nodes.map((node) => node.id).sort()).toEqual([state.hubNodeId, state.remoteNodeId].sort());
  const remote = nodes.find((node) => node.id === state.remoteNodeId);
  expect(remote?.online).toBe(true);
  expect(remote?.loggedIn).toBe(true);

  // 打开远端 node 一台设备的侧边栏显示（等价于「管理设备」里的终端开关）后，那一节才出现。
  const deviceName = `tmex-mesh-sidebar-${Date.now()}`;
  const deviceId = await createDeviceOnNode(page, state, state.remoteNodeId, {
    name: deviceName,
    session: deviceName,
  });
  try {
    await page.evaluate(
      (key) => {
        const raw = window.localStorage.getItem('tmex-ui');
        const parsed = (raw ? JSON.parse(raw) : { state: {}, version: 0 }) as {
          state?: { sidebarDeviceVisibility?: Record<string, boolean> };
        };
        const persistedState = parsed.state ?? {};
        persistedState.sidebarDeviceVisibility = {
          ...(persistedState.sidebarDeviceVisibility ?? {}),
          [key]: true,
        };
        window.localStorage.setItem(
          'tmex-ui',
          JSON.stringify({ ...parsed, state: persistedState, version: 0 })
        );
      },
      sidebarDeviceVisibilityKey(state.remoteNodeId, deviceId)
    );
    await page.reload();

    await expect(page.getByTestId(`sidebar-node-header-${state.remoteNodeId}`)).toBeVisible({
      timeout: 30_000,
    });
    // 徽标 title 是 `<展示名> · <nodeId>`。以 hub 为 entry 时 /api/mesh/nodes 的 name 取自
    // peers 表，刚 join 完那一段时间里会退化成 nodeId，所以断言只锚定 nodeId。
    await expect(page.getByTestId(`node-badge-${state.remoteNodeId}`).first()).toHaveAttribute(
      'title',
      new RegExp(`${state.remoteNodeId}$`)
    );
  } finally {
    await deleteDeviceOnNode(page, state, state.remoteNodeId, deviceId);
  }
});

test('mesh: terminal on the joined node echoes through the entry', async ({ page }) => {
  const sessionName = `tmex-mesh-e2e-${Date.now()}`;
  const marker = `TMEX_MESH_MARKER_${Date.now()}`;
  createRemoteTmuxSession(state, sessionName);
  let deviceId: string | undefined;

  try {
    await loginWithPassword(page, state);
    deviceId = await createDeviceOnNode(page, state, state.remoteNodeId, {
      name: sessionName,
      session: sessionName,
    });

    await page.goto(meshUrl(state, `/n/${state.remoteNodeId}/devices/${deviceId}`), {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('device-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });

    await page.locator('.xterm').first().click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');

    await expect.poll(() => readTerminalBuffer(page), { timeout: 30_000 }).toContain(marker);

    // 侧证：marker 真的落在远端 node 的 tmux pane 上，而不是只由前端本地回显。
    expect(meshTmux(state.nodeTmuxSocket, `capture-pane -p -t ${sessionName}`)).toContain(marker);
  } finally {
    if (deviceId) await deleteDeviceOnNode(page, state, state.remoteNodeId, deviceId);
    killRemoteTmuxSession(state, sessionName);
  }
});
