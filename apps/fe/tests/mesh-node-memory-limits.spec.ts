// 远程内存限额 e2e（契约第六章）：节点管理表对**另一台真实节点**开的「内存限额」入口。
//
// 拓扑是 relay-boot 的三进程 mesh：入口是 node A，目标是 node B。所有断言都打到 B 自己的
// `GET/PUT /api/settings/window-memory` 上——toast 只能证明前端自己觉得成功了，只有回读 B
// 才能证明那条 PUT 真的经 `/n/<B>/` 落到了 B 的库里。同时回读入口自身的同一端点，确认没有
// 写串到本机（这是 `/n/<id>` 前缀唯一可能出错的方向）。

import { type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  loginWithPassword,
  meshUrl,
  readMeshState,
  signInToNodeFromDevicesPage,
} from './helpers/mesh-e2e';

interface WindowMemorySettings {
  enabled: boolean;
  memoryHighMb: number;
  memoryMaxMb: number;
  memorySwapMaxMb: number;
  sampleIntervalSec: number;
}

const SETTINGS_PATH = 'api/settings/window-memory';

// 文案断言按浏览器语言三选一：e2e 的 Chromium 是 en-US，本地跑成中文 / 日文时也不该挂。
const SAVED_COPY = /Memory limits saved|内存限额已保存|メモリ上限を保存しました/;
const BULK_ONE_SAVED_COPY = /Written to 1 node|已写入 1 个节点|1 個のノードに書き込みました/;
const NOT_SIGNED_IN_COPY = /Not signed in|未登录|未ログイン/;
const SELECT_FIRST_COPY = /Select nodes first|须先勾选节点|先にノードを選択してください/;
const PAUSED_COPY = /Paused|已暂停|一時停止中/;

/** 行菜单打开时读到的那一份：刻意与 `WINDOW_MEMORY_SETTINGS_DEFAULTS` 每一项都不同。 */
const ROW_BASELINE: WindowMemorySettings = {
  enabled: false,
  memoryHighMb: 1234,
  memoryMaxMb: 2345,
  memorySwapMaxMb: 345,
  sampleIntervalSec: 7,
};
const ROW_EDITED_HIGH_MB = 1777;

/** 批量框写下去的那一份：与行内那一轮也不同，否则分不清是谁写的。 */
const BULK_SETTINGS: WindowMemorySettings = {
  enabled: true,
  memoryHighMb: 2222,
  memoryMaxMb: 3333,
  memorySwapMaxMb: 444,
  sampleIntervalSec: 9,
};

const RESTORE_SETTINGS: WindowMemorySettings = {
  enabled: true,
  memoryHighMb: 8192,
  memoryMaxMb: 12288,
  memorySwapMaxMb: 4096,
  sampleIntervalSec: 5,
};

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
});

function settingsUrl(nodeId: string | null): string {
  return meshUrl(state, nodeId ? `/n/${nodeId}/${SETTINGS_PATH}` : `/${SETTINGS_PATH}`);
}

/** `nodeId = null` 读入口自身（无 `/n/` 前缀）。 */
async function readSettings(page: Page, nodeId: string | null): Promise<WindowMemorySettings> {
  const res = await page.request.get(settingsUrl(nodeId));
  expect(
    res.ok(),
    `GET window-memory on ${nodeId ?? 'self'}: ${res.status()} ${await res.text()}`
  ).toBeTruthy();
  return (await res.json()) as WindowMemorySettings;
}

async function writeSettings(
  page: Page,
  nodeId: string | null,
  settings: WindowMemorySettings
): Promise<void> {
  const res = await page.request.put(settingsUrl(nodeId), { data: settings });
  expect(
    res.ok(),
    `PUT window-memory on ${nodeId ?? 'self'}: ${res.status()} ${await res.text()}`
  ).toBeTruthy();
  expect(await res.json()).toEqual(settings);
}

async function openNodesTab(page: Page, nodeId: string): Promise<void> {
  await page.goto(meshUrl(state, '/settings?tab=nodes'), { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('nodes-management')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`nodes-row-${nodeId}`)).toBeVisible({ timeout: 60_000 });
}

function memoryField(page: Page, prefix: string, field: keyof WindowMemorySettings) {
  return page.getByTestId(`${prefix}-${field}`);
}

async function expectFormShows(
  page: Page,
  prefix: string,
  settings: WindowMemorySettings
): Promise<void> {
  await expect(memoryField(page, prefix, 'enabled')).toHaveAttribute(
    'aria-checked',
    String(settings.enabled)
  );
  for (const field of [
    'memoryHighMb',
    'memoryMaxMb',
    'memorySwapMaxMb',
    'sampleIntervalSec',
  ] as const) {
    await expect(memoryField(page, prefix, field)).toHaveValue(String(settings[field]));
  }
}

async function fillMemoryForm(
  page: Page,
  prefix: string,
  settings: WindowMemorySettings
): Promise<void> {
  for (const field of [
    'memoryHighMb',
    'memoryMaxMb',
    'memorySwapMaxMb',
    'sampleIntervalSec',
  ] as const) {
    await memoryField(page, prefix, field).fill(String(settings[field]));
  }
  const toggle = memoryField(page, prefix, 'enabled');
  if ((await toggle.getAttribute('aria-checked')) !== String(settings.enabled)) {
    await toggle.click();
  }
}

interface MeshNodeRow {
  id: string;
  online: boolean;
  loggedIn: boolean;
  paused?: boolean;
}

/** 入口眼里的那一行；`loggedIn` 按**本请求**带的 cookie 判定，与页面共用同一个 cookie jar。 */
async function meshNodeRow(page: Page, nodeId: string): Promise<MeshNodeRow | undefined> {
  const res = await page.request.get(meshUrl(state, '/api/mesh/nodes'));
  expect(res.ok(), `GET mesh nodes: ${res.status()} ${await res.text()}`).toBeTruthy();
  const listed = (await res.json()) as { nodes: MeshNodeRow[] };
  return listed.nodes.find((node) => node.id === nodeId);
}

async function setPaused(page: Page, nodeId: string, paused: boolean): Promise<void> {
  const action = paused ? 'pause' : 'resume';
  const res = await page.request.post(meshUrl(state, `/api/mesh/nodes/${nodeId}/${action}`));
  expect(res.ok(), `${action} ${nodeId}: ${res.status()} ${await res.text()}`).toBeTruthy();
}

function toast(page: Page, copy: RegExp) {
  return page.locator('[data-sonner-toast]').filter({ hasText: copy });
}

test('mesh: the row memory item loads node B current limits and writes them back to B', async ({
  page,
}) => {
  const nodeId = state.remoteNodeId;
  await loginWithPassword(page, state);
  await signInToNodeFromDevicesPage(page, nodeId);

  // 先把 B 设成一份与缺省值处处不同的记录：这样「表单里读到的是 B 的当前值」才证得出来。
  await writeSettings(page, nodeId, ROW_BASELINE);
  const entryBefore = await readSettings(page, null);

  await openNodesTab(page, nodeId);
  await page.getByTestId(`node-more-${nodeId}`).click();
  const item = page.getByTestId(`nodes-memory-${nodeId}`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item).not.toHaveAttribute('data-disabled');
  await item.click();

  const dialog = page.getByTestId(`nodes-memory-dialog-${nodeId}`);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const prefix = `nodes-memory-${nodeId}`;
  await expect(page.getByTestId(`${prefix}-form`)).toBeVisible({ timeout: 15_000 });
  await expectFormShows(page, prefix, ROW_BASELINE);

  await memoryField(page, prefix, 'memoryHighMb').fill(String(ROW_EDITED_HIGH_MB));
  await page.getByTestId(`nodes-memory-save-${nodeId}`).click();
  await expect(toast(page, SAVED_COPY)).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });

  // 唯一有分量的断言：B 自己回的那份记录。
  expect(await readSettings(page, nodeId)).toEqual({
    ...ROW_BASELINE,
    memoryHighMb: ROW_EDITED_HIGH_MB,
  });
  // 入口自身不能被写串。
  expect(await readSettings(page, null)).toEqual(entryBefore);
});

test('mesh: the bulk memory action writes one form to the selected node B', async ({ page }) => {
  const nodeId = state.remoteNodeId;
  await loginWithPassword(page, state);
  await signInToNodeFromDevicesPage(page, nodeId);

  await writeSettings(page, nodeId, ROW_BASELINE);
  const entryBefore = await readSettings(page, null);

  await openNodesTab(page, nodeId);

  // 一台都没勾时这一项是禁用的，禁用原因就是「须先勾选节点」。
  await page.getByTestId('nodes-bulk-menu').click();
  const bulkItem = page.getByTestId('nodes-bulk-memory');
  await expect(bulkItem).toBeVisible({ timeout: 15_000 });
  await expect(bulkItem).toHaveAttribute('data-disabled');
  await expect(bulkItem).toHaveAttribute('title', SELECT_FIRST_COPY);
  await page.keyboard.press('Escape');
  await expect(bulkItem).toHaveCount(0, { timeout: 15_000 });

  await page.getByTestId(`nodes-select-${nodeId}`).click();
  await page.getByTestId('nodes-bulk-menu').click();
  await expect(bulkItem).toBeVisible({ timeout: 15_000 });
  await expect(bulkItem).not.toHaveAttribute('data-disabled');
  await bulkItem.click();

  const dialog = page.getByTestId('nodes-memory-bulk-dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  // 名单把「写给谁」说清楚：B 在目标里，且没有节点被跳过。
  await expect(page.getByTestId(`nodes-memory-target-${nodeId}`)).toBeVisible();
  await expect(page.getByTestId(`nodes-memory-skip-${nodeId}`)).toHaveCount(0);
  await expect(page.getByTestId('nodes-memory-bulk-effect')).toBeVisible();

  await fillMemoryForm(page, 'nodes-memory-bulk', BULK_SETTINGS);
  await page.getByTestId('nodes-memory-bulk-apply').click();

  // 一台成功 = 汇总提示报 1 台 + 框自己关掉（有失败时框会留着并列出失败节点）。
  await expect(toast(page, BULK_ONE_SAVED_COPY)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`nodes-memory-failed-${nodeId}`)).toHaveCount(0);
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });

  expect(await readSettings(page, nodeId)).toEqual(BULK_SETTINGS);
  expect(await readSettings(page, null)).toEqual(entryBefore);

  // 把 B 放回缺省值，别把自定义限额留给后面的 mesh 用例。
  await writeSettings(page, nodeId, RESTORE_SETTINGS);
});

test('mesh: the row memory item is disabled while node B is paused', async ({ page }) => {
  const nodeId = state.remoteNodeId;
  await loginWithPassword(page, state);
  await signInToNodeFromDevicesPage(page, nodeId);
  await openNodesTab(page, nodeId);

  try {
    await setPaused(page, nodeId, true);
    // 暂停是 entry 本机偏好，节点仍然在线（实测 `online` 保持 true），因此跳过原因恒为
    // 「已暂停」而非「离线」——离线那一档排在它前面，这里先把状态钉死再断言文案。
    const paused = await meshNodeRow(page, nodeId);
    expect(paused?.paused).toBe(true);
    expect(paused?.online).toBe(true);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(`nodes-row-${nodeId}`)).toBeVisible({ timeout: 60_000 });
    await page.getByTestId(`node-more-${nodeId}`).click();
    const item = page.getByTestId(`nodes-memory-${nodeId}`);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(item).toHaveAttribute('data-disabled');
    await expect(item).toHaveAttribute('title', PAUSED_COPY);
    await page.keyboard.press('Escape');
  } finally {
    await setPaused(page, nodeId, false);
  }

  // 恢复后必须把 mesh 还回可用状态，后面的 mesh 用例还要用 B。
  await expect
    .poll(async () => (await meshNodeRow(page, nodeId))?.online === true, { timeout: 120_000 })
    .toBe(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId(`nodes-row-${nodeId}`)).toBeVisible({ timeout: 60_000 });
  await page.getByTestId(`node-more-${nodeId}`).click();
  const back = page.getByTestId(`nodes-memory-${nodeId}`);
  await expect(back).toBeVisible({ timeout: 15_000 });
  await expect(back).not.toHaveAttribute('data-disabled', { timeout: 30_000 });
});

test('mesh: the row memory item tracks whether node B has a session on this browser', async ({
  page,
}) => {
  const nodeId = state.remoteNodeId;
  // 这条刻意**不**走 signInToNodeFromDevicesPage：新 context 里 B 没有 node-session cookie。
  // 但入口会自己替已知节点静默登录，什么时候登完不确定，所以这里断言的是**不变式**
  // （「禁用」当且仅当「未登录」）而不是某个固定状态：静默登录是单向的（登上就不会退回去），
  // 因此轮询必然收敛到两种合法组合之一。
  await loginWithPassword(page, state);
  await openNodesTab(page, nodeId);

  await page.getByTestId(`node-more-${nodeId}`).click();
  const item = page.getByTestId(`nodes-memory-${nodeId}`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const row = await meshNodeRow(page, nodeId);
        const disabled = (await item.getAttribute('data-disabled')) !== null;
        return `loggedIn=${row?.loggedIn} disabled=${disabled}`;
      },
      { timeout: 30_000 }
    )
    .toMatch(/^(loggedIn=false disabled=true|loggedIn=true disabled=false)$/);

  // 落在「未登录」那一档时，禁用原因必须就是未登录。
  if ((await meshNodeRow(page, nodeId))?.loggedIn === false) {
    await expect(item).toHaveAttribute('title', NOT_SIGNED_IN_COPY);
  }
});
