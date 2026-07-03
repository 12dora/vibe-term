import { expect, test, type Page } from '@playwright/test';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// issue-45 bug 2 e2e 骨架
// 场景：单 pane → split-down 翻转后，老 pane 终端内容应保留。
// 根因（ws/index.ts:1304-1308）：broadcastTerminalHistory 用 selectedPanes 路由
//   barrier history，split 后焦点切到 P2，P1 的 barrier history 落入 fetch 分支被丢弃，
//   P1 barrier 卡在 ACKED，老 pane 内容丢失（canvas ink 接近 0）。
// 必须用单 pane 起始（单→split 翻转路径）；直接起双 pane 已是稳态，不触发 bug。
// 修复前 fail（老 pane ink < 阈值）；Task 7 修复后 pass。
//
// 当前状态：简单单→split 场景下老 pane 内容未稳定丢失（ink 保留），test.fixme 标注。
// bug 2 的可视复现需要更精确时序（DevicePage.tsx:516-521 isSplitView 翻转 effect
// 触发老 pane 重新 dispatch select，与 selectedPanes 已切到新 pane 的竞态）。
// 单测 switch-barrier.issue45.test.ts 已精确锁定协议层根因（red）。
// Task 7 修复时应取消 fixme 并视需要精化场景（如 split 后显式切回老 pane）。

test.use({ viewport: { width: 1280, height: 800 } });

const MARKER = 'MARKER_LEFT_42';

async function readInkFirstCanvas(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-terminal-engine] canvas'
    ) as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
    const { width, height } = canvas;
    const sample = ctx.getImageData(0, 0, width, height).data;
    const bgR = sample[0] ?? 0;
    const bgG = sample[1] ?? 0;
    const bgB = sample[2] ?? 0;
    let painted = 0;
    let total = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const index = (y * width + x) * 4;
        const a = sample[index + 3] ?? 0;
        const dist =
          Math.abs((sample[index] ?? 0) - bgR) +
          Math.abs((sample[index + 1] ?? 0) - bgG) +
          Math.abs((sample[index + 2] ?? 0) - bgB);
        if (a > 0 && dist > 24) painted += 1;
        total += 1;
      }
    }
    return total === 0 ? 0 : painted / total;
  });
}

async function readInkByPane(page: Page, paneId: string): Promise<number> {
  return page.evaluate((id) => {
    const canvas = document.querySelector(
      `[data-pane-id="${id}"] [data-terminal-engine] canvas`
    ) as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const ctx = canvas.getContext('2d');
    if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
    const { width, height } = canvas;
    const sample = ctx.getImageData(0, 0, width, height).data;
    const bgR = sample[0] ?? 0;
    const bgG = sample[1] ?? 0;
    const bgB = sample[2] ?? 0;
    let painted = 0;
    let total = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const index = (y * width + x) * 4;
        const a = sample[index + 3] ?? 0;
        const dist =
          Math.abs((sample[index] ?? 0) - bgR) +
          Math.abs((sample[index + 1] ?? 0) - bgG) +
          Math.abs((sample[index + 2] ?? 0) - bgB);
        if (a > 0 && dist > 24) painted += 1;
        total += 1;
      }
    }
    return total === 0 ? 0 : painted / total;
  }, paneId);
}

test.fixme('issue-45 bug 2: single pane → split-down preserves original pane content', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-issue45-split-${Date.now()}`;
  const { paneId: originalPaneId } = createSinglePaneSession(sessionName);
  expect(originalPaneId).toBeTruthy();

  const name = `e2e-issue45-split-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const { device } = (await createRes.json()) as { device: { id: string } };

  try {
    await page.goto(`/devices/${device.id}`);
    await expect(page.getByTestId('device-page')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-terminal-engine] canvas').first()).toBeVisible({
      timeout: 20_000,
    });

    await page.keyboard.type(`echo "${MARKER}"\r`, { delay: 8 });

    await expect
      .poll(
        () => tmux(`capture-pane -p -t ${originalPaneId}`).includes(MARKER),
        { timeout: 20_000 }
      )
      .toBeTruthy();

    await expect
      .poll(() => readInkFirstCanvas(page), { timeout: 20_000 })
      .toBeGreaterThan(0.002);

    const baseline = await readInkFirstCanvas(page);

    await page.getByTestId('split-down-button').click();

    await expect(page.getByTestId('split-terminal-area')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('split-pane')).toHaveCount(2, { timeout: 15_000 });
    await expect(
      page.locator(`[data-testid="split-pane"][data-pane-id="${originalPaneId}"]`)
    ).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(1000);

    await expect
      .poll(() => readInkByPane(page, originalPaneId!), { timeout: 10_000 })
      .toBeGreaterThan(baseline * 0.3);
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
