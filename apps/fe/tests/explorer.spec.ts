import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

// 文件管理器：从侧栏打开目录，在主区域里导航、多选、新建 / 重命名 / 删除、拖拽移动、分栏。
// 本机文件走 node:fs（与 tmux 无关），无需连接 tmux 会话。

let sandbox: string;

test.afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

const shotsDir = process.env.VIBETERM_E2E_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

test('explorer: 打开、导航、多选、文件操作、拖拽移动与分栏', async ({ page }) => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-e2e-explorer-')));
  mkdirSync(join(sandbox, 'alpha'));
  mkdirSync(join(sandbox, 'beta'));
  writeFileSync(join(sandbox, 'alpha', 'inner.txt'), 'inner');
  writeFileSync(join(sandbox, 'a.txt'), 'a');
  writeFileSync(join(sandbox, 'b.txt'), 'bb');
  writeFileSync(join(sandbox, 'c.md'), '# c');

  const devRes = await page.request.post('/api/devices', {
    data: { name: `e2e-explorer-${Date.now()}`, type: 'local', authMode: 'auto' },
  });
  expect(devRes.ok()).toBeTruthy();
  const deviceId = (await devRes.json()).device.id as string;
  const rootRes = await page.request.post('/api/files/roots', {
    data: { deviceId, path: sandbox, enabled: true },
  });
  expect(rootRes.ok()).toBeTruthy();
  const rootId = (await rootRes.json()).root.id as string;

  // 1. 侧栏根目录行的「打开」→ 进入文件管理器
  await page.goto('/');
  await page.getByTestId('sidebar-tab-files').click();
  const openToggle = page.getByTestId(`file-root-explorer-${rootId}`);
  await expect(openToggle).toHaveText('Open');
  await openToggle.click();
  await expect(page).toHaveURL(/\/explorer$/);

  const browser = page.getByTestId('explorer-browser');
  const item = (name: string) => browser.getByTestId(`explorer-item-${name}`);
  await expect(item('a.txt')).toBeVisible();
  await expect(item('alpha')).toBeVisible();
  await expect(openToggle).toHaveText('Close');
  await expect(page.getByTestId('explorer-status-items')).toContainText('5');
  await shot(page, '01-opened');

  // 2. 双击进入目录，后退回来
  await item('alpha').dblclick();
  await expect(item('inner.txt')).toBeVisible();
  await shot(page, '02-inside-alpha');
  await page.getByTestId('explorer-back').click();
  await expect(item('a.txt')).toBeVisible();

  // 3. 多选：单击 + Shift 连选，再全选
  const selected = page.getByTestId('explorer-status-selected');
  await item('a.txt').click();
  await item('c.md').click({ modifiers: ['Shift'] });
  await expect(selected).toContainText('3');
  await page.keyboard.press('ControlOrMeta+a');
  await expect(selected).toContainText('5');
  await shot(page, '03-select-all');
  await page.keyboard.press('Escape');

  // 4. 键盘导航：方向键移动、Enter 进入、Backspace 返回上一级
  await item('alpha').click();
  await page.keyboard.press('Enter');
  await expect(item('inner.txt')).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(item('alpha')).toBeVisible();
  await expect(item('alpha')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(item('beta')).toHaveAttribute('aria-selected', 'true');

  // 5. 新建文件夹（行内命名）
  await page.getByTestId('explorer-new-folder').click();
  const editor = browser.locator('input[type="text"]:focus');
  await expect(editor).toBeVisible();
  await editor.fill('gamma');
  await editor.press('Enter');
  await expect(item('gamma')).toBeVisible();
  expect(existsSync(join(sandbox, 'gamma'))).toBe(true);

  // 6. F2 重命名
  await item('a.txt').click();
  await page.keyboard.press('F2');
  const renameEditor = browser.locator('input[type="text"]:focus');
  await expect(renameEditor).toBeVisible();
  await renameEditor.fill('renamed.txt');
  await renameEditor.press('Enter');
  await expect(item('renamed.txt')).toBeVisible();
  await expect(item('a.txt')).toHaveCount(0);
  expect(existsSync(join(sandbox, 'renamed.txt'))).toBe(true);

  // 7. Delete 删除（需确认）
  await item('b.txt').click();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await shot(page, '04-delete-confirm');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(item('b.txt')).toHaveCount(0);
  await expect.poll(() => existsSync(join(sandbox, 'b.txt'))).toBe(false);

  // 8. 拖到文件夹上 = 同设备内移动
  // 只有图标 + 名称一格是拖拽源：从行的其余位置拖出来是框选（与访达 / 资源管理器一致）
  await item('c.md').dragTo(item('beta'), {
    sourcePosition: { x: 40, y: 15 },
    targetPosition: { x: 40, y: 15 },
  });
  await expect(item('c.md')).toHaveCount(0);
  await expect.poll(() => existsSync(join(sandbox, 'beta', 'c.md'))).toBe(true);
  expect(existsSync(join(sandbox, 'c.md'))).toBe(false);

  // 9. 右键菜单
  await item('renamed.txt').click({ button: 'right' });
  const menuItem = (name: string) => page.getByRole('menuitem', { name });
  await expect(menuItem('Rename')).toBeVisible();
  await expect(menuItem('Download')).toBeVisible();
  await expect(menuItem('Delete')).toBeVisible();
  await shot(page, '05-context-menu');
  await page.keyboard.press('Escape');
  await expect(menuItem('Rename')).toHaveCount(0);

  // 10. 分栏：两个分栏各自有标签页
  await page.getByTestId('explorer-split').click();
  await expect(page.locator('[data-testid^="explorer-pane-"]')).toHaveCount(2);
  await expect(page.getByTestId('explorer-browser')).toHaveCount(2);
  await shot(page, '06-split');

  // 11. 侧栏「关闭」→ 该目录的标签页全部关掉，回到空态
  await openToggle.click();
  await expect(page.getByTestId('explorer-empty')).toBeVisible();
  await expect(openToggle).toHaveText('Open');
  await shot(page, '07-empty');
});
