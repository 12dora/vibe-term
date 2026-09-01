import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// round11 bug B：在文件侧栏拖动根目录时，被拖的行跟着指针横移，撑出的横向溢出让侧栏
// 整体往右滚（Base UI 的 ScrollArea viewport 内联 `overflow: scroll`）。
// 修法两道：SortableVerticalList 的竖轴 modifier + viewport 只保留纵向滚动。

let sandboxA: string;
let sandboxB: string;

test.afterAll(() => {
  for (const dir of [sandboxA, sandboxB]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('files: 拖动根目录不会把侧栏横向滚动，且纵向重排生效', async ({ page }) => {
  sandboxA = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-drag-a-')));
  sandboxB = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-drag-b-')));
  writeFileSync(join(sandboxA, 'a.txt'), 'a');
  writeFileSync(join(sandboxB, 'b.txt'), 'b');

  const devRes = await page.request.post('/api/devices', {
    data: { name: `e2e-drag-${Date.now()}`, type: 'local', authMode: 'auto' },
  });
  expect(devRes.ok()).toBeTruthy();
  const deviceId = (await devRes.json()).device.id as string;

  const createRoot = async (path: string): Promise<string> => {
    const res = await page.request.post('/api/files/roots', {
      data: { deviceId, path, enabled: true },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).root.id as string;
  };
  const rootA = await createRoot(sandboxA);
  const rootB = await createRoot(sandboxB);

  await page.goto('/');
  await page.getByTestId('sidebar-tab-files').click();
  await expect(page.getByTestId('files-tab')).toBeVisible();

  const rowA = page.getByTestId(`file-dir-${rootA}-${sandboxA}`);
  const rowB = page.getByTestId(`file-dir-${rootB}-${sandboxB}`);
  await expect(rowA).toBeVisible();
  await expect(rowB).toBeVisible();

  const viewport = page.getByTestId('files-tab').locator('[data-slot="scroll-area-viewport"]');
  const metrics = () =>
    viewport.evaluate((el) => ({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));

  const before = await metrics();
  expect(before.scrollLeft).toBe(0);
  expect(before.scrollWidth).toBeLessThanOrEqual(before.clientWidth);

  // 拖 A 的手柄：先往右 200px（横向必须无效），再落到 B 行的中心（纵向必须生效）
  const handle = page.getByTestId(`file-root-drag-${rootA}`);
  const handleBox = await handle.boundingBox();
  const targetBox = await rowB.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  if (!handleBox || !targetBox) return;
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  const targetY = targetBox.y + targetBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // MouseSensor 的激活阈值是 8px：先小幅移动确认不误触，再真正起拖
  await page.mouse.move(startX + 4, startY + 2);
  await page.mouse.move(startX + 40, startY + 12, { steps: 5 });
  await page.mouse.move(startX + 200, targetY, { steps: 10 });
  await page.mouse.move(startX + 200, targetY + 60, { steps: 5 });
  await page.mouse.move(startX + 200, targetY, { steps: 5 });

  const during = await metrics();
  expect(during.scrollLeft).toBe(0);
  expect(during.scrollWidth).toBeLessThanOrEqual(during.clientWidth);

  await page.mouse.up();

  const after = await metrics();
  expect(after.scrollLeft).toBe(0);
  expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth);

  // 纵向重排生效：A 落到 B 之后（顺序由服务端收口，等一次 invalidate 后的刷新）
  await expect
    .poll(
      async () => {
        const order = await viewport.evaluate(
          (el, ids) => {
            const testIds = [...el.querySelectorAll('[data-testid^="file-dir-"]')].map(
              (node) => node.getAttribute('data-testid') ?? ''
            );
            const indexOf = (rootId: string) =>
              testIds.findIndex((value) => value.startsWith(`file-dir-${rootId}-`));
            return { a: indexOf(ids.a), b: indexOf(ids.b) };
          },
          { a: rootA, b: rootB }
        );
        return order.b >= 0 && order.a > order.b;
      },
      { timeout: 10_000 }
    )
    .toBe(true);
});
