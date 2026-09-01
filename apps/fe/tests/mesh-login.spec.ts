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
  openDevicesPage,
  readMeshState,
  readTerminalBuffer,
  signInToNodeFromDevicesPage,
} from './helpers/mesh';

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

/** 浏览器此刻有没有该 node 的会话 cookie（`/api/mesh/nodes` 的 `loggedIn` 就是这个）。 */
async function nodeLoggedIn(page: Page, nodeId: string): Promise<boolean> {
  return page.evaluate(
    (id) =>
      fetch('/api/mesh/nodes', { credentials: 'include' })
        .then((res) => res.json())
        .then(
          (body: { nodes: { id: string; loggedIn: boolean }[] }) =>
            body.nodes.find((node) => node.id === id)?.loggedIn === true
        )
        .catch(() => false),
    nodeId
  );
}

test('mesh: other nodes join the sidebar only after one of their devices is enabled', async ({
  page,
}) => {
  await loginWithPassword(page, state);

  const nodeList = page.getByTestId('sidebar-node-list');
  await expect(nodeList).toBeVisible({ timeout: 30_000 });

  // entry（hub）在侧边栏用 `self` 作为 runtime node id；远端 node 的设备缺省不显示，
  // 整节（含登录入口）都不出现——登录别的节点统一走「管理设备」。
  await expect(page.getByTestId('sidebar-node-header-self')).toBeVisible();
  await expect(page.getByTestId(`sidebar-node-header-${state.remoteNodeId}`)).toHaveCount(0);

  // 侧边栏渲染的成员集就是 entry 的 /api/mesh/nodes：两台、远端在线。
  // `loggedIn` 看的是浏览器有没有该 node 的会话 cookie；登录页只登录 entry 自身
  // （`loginSelf` 明确不做 fan-out），所以这时远端仍是未登录。
  const nodes = await page.evaluate(() =>
    fetch('/api/mesh/nodes', { credentials: 'include' })
      .then((res) => res.json())
      .then((body: { nodes: { id: string; online: boolean; loggedIn: boolean }[] }) => body.nodes)
  );
  expect(nodes.map((node) => node.id).sort()).toEqual([state.hubNodeId, state.remoteNodeId].sort());
  const remote = nodes.find((node) => node.id === state.remoteNodeId);
  expect(remote?.online).toBe(true);
  expect(remote?.loggedIn).toBe(false);

  // 「管理设备」里登录远端 node：登录成功后它在设备页可管理，但侧边栏仍然不列出——
  // 一台设备都没打开侧边栏显示。
  await signInToNodeFromDevicesPage(page, state.remoteNodeId);
  await expect(page.getByTestId(`devices-node-header-${state.remoteNodeId}`)).toBeVisible();
  await expect(page.getByTestId(`sidebar-node-header-${state.remoteNodeId}`)).toHaveCount(0);

  const deviceName = `tmex-mesh-sidebar-${Date.now()}`;
  const deviceId = await createDeviceOnNode(page, state, state.remoteNodeId, {
    name: deviceName,
    session: deviceName,
  });
  try {
    await page.reload();
    await expect(page.getByTestId('devices-page-container')).toBeVisible({ timeout: 30_000 });
    const card = page.locator(`[data-testid="device-card"][data-device-id="${deviceId}"]`);
    await expect(card).toBeVisible({ timeout: 30_000 });

    // 卡片上的「终端」开关就是侧边栏显示开关：打开后那一节才出现。
    await page.getByTestId(`device-card-sidebar-${deviceId}`).click();
    await expect(page.getByTestId(`sidebar-node-header-${state.remoteNodeId}`)).toBeVisible({
      timeout: 30_000,
    });
    // 徽标 title 是 `<展示名> · <nodeId>`。以 hub 为 entry 时 /api/mesh/nodes 的 name 取自
    // peers 表，刚 join 完那一段时间里会退化成 nodeId，所以断言只锚定 nodeId。
    await expect(
      page.getByTestId('sidebar-node-list').getByTestId(`node-badge-${state.remoteNodeId}`).first()
    ).toHaveAttribute('title', new RegExp(`${state.remoteNodeId}$`));
  } finally {
    await deleteDeviceOnNode(page, state, state.remoteNodeId, deviceId);
  }
});

test('mesh: the remote node signs in silently, and survives a full page reload', async ({
  page,
}) => {
  await loginWithPassword(page, state);

  // SPA 内部跳到设备页：一下都不用点，远端 node 由静默门闸自己登上（会话钥还在内存里）。
  await openDevicesPage(page);
  await expect(page.getByTestId(`devices-node-panel-${state.remoteNodeId}`)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId(`devices-node-login-${state.remoteNodeId}`)).toHaveCount(0);
  await expect(page.getByTestId('login-page')).toHaveCount(0);

  // 撤掉远端 node 的会话 cookie 再整页刷新：新 document 的内存是空的，只能靠 IndexedDB 里
  // 那把不可导出的 sk_sess 恢复出会话钥再登一次——iOS PWA 每次冷启动就是这个场景。
  await page.context().clearCookies({ name: `tmex_s_${state.remoteNodeId}` });
  expect(await nodeLoggedIn(page, state.remoteNodeId)).toBe(false);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('devices-page-container')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`devices-node-panel-${state.remoteNodeId}`)).toBeVisible({
    timeout: 60_000,
  });
  // 既没退回登录页，也没退回「登录此节点」按钮
  await expect(page.getByTestId('login-page')).toHaveCount(0);
  await expect(page.getByTestId(`node-login-${state.remoteNodeId}`)).toHaveCount(0);
  // 侧证：会话 cookie 是这次刷新之后重新签发的
  await expect.poll(() => nodeLoggedIn(page, state.remoteNodeId), { timeout: 30_000 }).toBe(true);
});

test('mesh: terminal on the joined node echoes through the entry', async ({ page }) => {
  const sessionName = `tmex-mesh-e2e-${Date.now()}`;
  const marker = `TMEX_MESH_MARKER_${Date.now()}`;
  createRemoteTmuxSession(state, sessionName);
  let deviceId: string | undefined;

  try {
    await loginWithPassword(page, state);
    // `/n/:id/api/*` 要该 node 的会话；按需登录的入口在「管理设备」里。
    await signInToNodeFromDevicesPage(page, state.remoteNodeId);
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
