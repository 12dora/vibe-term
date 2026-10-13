import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

test('explorer: 分栏间拖拽移动、剪切粘贴、图标视图与打包下载', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-e2e-explorer2-')));
  try {
    mkdirSync(join(root, 'left'));
    mkdirSync(join(root, 'right'));
    writeFileSync(join(root, 'left', 'one.txt'), '1');
    writeFileSync(join(root, 'left', 'two.txt'), '22');
    writeFileSync(join(root, 'left', 'three.txt'), '333');

    const devRes = await page.request.post('/api/devices', {
      data: { name: `e2e-explorer2-${Date.now()}`, type: 'local', authMode: 'auto' },
    });
    const deviceId = (await devRes.json()).device.id as string;
    const rootRes = await page.request.post('/api/files/roots', {
      data: { deviceId, path: root, enabled: true },
    });
    const rootId = (await rootRes.json()).root.id as string;

    await page.goto('/');
    await page.getByTestId('sidebar-tab-files').click();
    await page.getByTestId(`file-root-explorer-${rootId}`).click();
    await expect(page.getByTestId('explorer-browser')).toHaveCount(1);

    // 左右两栏：左栏进 left，右栏进 right
    await page.getByTestId('explorer-split').click();
    const panes = page.getByTestId('explorer-browser');
    await expect(panes).toHaveCount(2);
    const left = panes.nth(0);
    const right = panes.nth(1);
    await left.getByTestId('explorer-item-left').dblclick();
    await expect(left.getByTestId('explorer-item-one.txt')).toBeVisible();
    await right.getByTestId('explorer-item-right').dblclick();
    await expect(right.getByTestId('explorer-status-items')).toContainText('0');

    // 多选两项后从左栏拖到右栏空白处：同设备 = 移动
    await left.getByTestId('explorer-item-one.txt').click();
    await left.getByTestId('explorer-item-two.txt').click({ modifiers: ['ControlOrMeta'] });
    await left
      .getByTestId('explorer-item-one.txt')
      .dragTo(right.getByTestId('explorer-content'), { sourcePosition: { x: 40, y: 15 } });
    await expect(right.getByTestId('explorer-item-one.txt')).toBeVisible();
    await expect(right.getByTestId('explorer-item-two.txt')).toBeVisible();
    await expect(left.getByTestId('explorer-item-one.txt')).toHaveCount(0);
    expect(existsSync(join(root, 'right', 'one.txt'))).toBe(true);
    expect(existsSync(join(root, 'left', 'two.txt'))).toBe(false);
    await shot(page, '10-cross-pane-move');

    // 剪切 + 粘贴：把 three.txt 从左栏剪到右栏
    await left.getByTestId('explorer-item-three.txt').click();
    await page.keyboard.press('ControlOrMeta+x');
    await right.getByTestId('explorer-view').click({ position: { x: 300, y: 300 } });
    await page.keyboard.press('ControlOrMeta+v');
    await expect(right.getByTestId('explorer-item-three.txt')).toBeVisible();
    await expect.poll(() => existsSync(join(root, 'left', 'three.txt'))).toBe(false);

    // 图标视图
    await right.getByTestId('explorer-view-grid').click();
    await expect(right.getByTestId('explorer-item-one.txt')).toBeVisible();
    await shot(page, '11-grid-view');

    // 全选后下载：多项打包为 tar.gz，由浏览器直接接管
    await right.getByTestId('explorer-item-one.txt').click();
    await page.keyboard.press('ControlOrMeta+a');
    const download = page.waitForEvent('download');
    await page.keyboard.press('ControlOrMeta+s');
    expect((await download).suggestedFilename()).toBe('right.tar.gz');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explorer: 侧栏新建 / 重命名 / 删除、Esc 取消行内编辑、上传同名先询问', async ({ page }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-e2e-explorer3-')));
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'note.txt'), 'old');
    writeFileSync(join(root, 'keep.txt'), 'keep');

    const devRes = await page.request.post('/api/devices', {
      data: { name: `e2e-explorer3-${Date.now()}`, type: 'local', authMode: 'auto' },
    });
    const deviceId = (await devRes.json()).device.id as string;
    const rootRes = await page.request.post('/api/files/roots', {
      data: { deviceId, path: root, enabled: true },
    });
    const rootId = (await rootRes.json()).root.id as string;

    await page.goto('/');
    await page.getByTestId('sidebar-tab-files').click();
    const rootRow = page.getByTestId(`file-dir-${rootId}-${root}`);
    await rootRow.click();
    const menuItem = (name: string) => page.getByRole('menuitem', { name, exact: true });

    // 侧栏：右键根目录 → 新建文件夹。输入框自动聚焦并选中默认名，直接打字即可覆盖
    await rootRow.click({ button: 'right' });
    await menuItem('New Folder').click();
    const nameInput = page.getByTestId('file-name-input');
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveValue('untitled folder');
    await page.keyboard.type('inbox');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('file-name-dialog')).toHaveCount(0);
    await expect.poll(() => existsSync(join(root, 'inbox'))).toBe(true);
    const inboxRow = page.getByTestId(`file-dir-${rootId}-${root}/inbox`);
    await expect(inboxRow).toBeVisible();

    // 侧栏：重命名文件（只选中主名，扩展名保留）
    const keepRow = page.getByTestId(`file-item-${rootId}-${root}/keep.txt`);
    await keepRow.click({ button: 'right' });
    await menuItem('Rename').click();
    await expect(nameInput).toBeFocused();
    await page.keyboard.type('kept');
    await page.keyboard.press('Enter');
    await expect.poll(() => existsSync(join(root, 'kept.txt'))).toBe(true);
    expect(existsSync(join(root, 'keep.txt'))).toBe(false);

    // 侧栏：删除文件夹需确认
    await inboxRow.click({ button: 'right' });
    await menuItem('Delete').click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('inbox');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => existsSync(join(root, 'inbox'))).toBe(false);
    await shot(page, '20-sidebar-ops');

    // 侧栏：在文件管理器中打开子目录
    const docsRow = page.getByTestId(`file-dir-${rootId}-${root}/docs`);
    await docsRow.click({ button: 'right' });
    await menuItem('Open in File Manager').click();
    await expect(page).toHaveURL(/\/explorer$/);
    const browser = page.getByTestId('explorer-browser');
    const item = (name: string) => browser.getByTestId(`explorer-item-${name}`);
    await expect(item('note.txt')).toBeVisible();

    // Esc 取消行内重命名：名称不变
    await item('note.txt').click();
    await page.keyboard.press('F2');
    const editor = browser.locator('input[type="text"]:focus');
    await expect(editor).toBeVisible();
    await editor.fill('changed.txt');
    await editor.press('Escape');
    await expect(item('note.txt')).toBeVisible();
    await page.waitForTimeout(300);
    expect(existsSync(join(root, 'docs', 'note.txt'))).toBe(true);
    expect(existsSync(join(root, 'docs', 'changed.txt'))).toBe(false);

    // Esc 取消新建文件夹：不创建
    await page.getByTestId('explorer-new-folder').click();
    const pending = browser.getByTestId('explorer-pending-folder');
    await expect(pending).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pending).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(existsSync(join(root, 'docs', 'untitled folder'))).toBe(false);

    // 上传同名文件：先询问。跳过 → 原文件不变；替换 → 被覆盖
    const upload = async (content: string) => {
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('explorer-upload').click();
      await (await chooser).setFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(content),
      });
    };
    await upload('new-1');
    const conflict = page.getByRole('alertdialog');
    await expect(conflict).toContainText('note.txt');
    await shot(page, '21-upload-conflict');
    await conflict.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(conflict).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(readFileSync(join(root, 'docs', 'note.txt'), 'utf8')).toBe('old');

    await upload('new-2');
    await expect(conflict).toContainText('note.txt');
    await conflict.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect.poll(() => readFileSync(join(root, 'docs', 'note.txt'), 'utf8')).toBe('new-2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
