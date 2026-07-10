import { type Locator, expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

test.use({ viewport: { width: 1280, height: 800 } });

function paneWidths(sessionName: string): Record<string, number> {
  return tmux(`list-panes -t ${sessionName} -F '#{pane_id}:#{pane_width}'`)
    .split(/\r?\n/)
    .map((line) => line.trim().split(':'))
    .reduce<Record<string, number>>((acc, [id, width]) => {
      if (id) acc[id] = Number(width);
      return acc;
    }, {});
}

async function waitForStablePaneWidths(sessionName: string): Promise<Record<string, number>> {
  let current = paneWidths(sessionName);
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const next = paneWidths(sessionName);
    if (JSON.stringify(next) === JSON.stringify(current)) return next;
    current = next;
  }
  return current;
}

function hasVisiblePaint(color: string): boolean {
  const normalized = color.replaceAll(' ', '').toLowerCase();
  return (
    normalized !== 'transparent' && normalized !== 'rgba(0,0,0,0)' && !normalized.endsWith('/0)')
  );
}

function colorAlpha(color: string): number | null {
  const normalized = color.replaceAll(' ', '').toLowerCase();
  if (normalized === 'transparent' || normalized === 'rgba(0,0,0,0)') return 0;

  const rgba = normalized.match(/^rgba?\([^,]+,[^,]+,[^,]+(?:,([\d.]+))?\)$/);
  if (rgba) return rgba[1] ? Number(rgba[1]) : 1;

  const slashAlpha = normalized.match(/\/([\d.]+)\)$/);
  return slashAlpha ? Number(slashAlpha[1]) : 1;
}

async function getVisualStyle(locator: Locator): Promise<{
  width: number;
  height: number;
  backgroundColor: string;
}> {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      width: rect.width,
      height: rect.height,
      backgroundColor: style.backgroundColor,
    };
  });
}

test('desktop: multi-pane window renders split view with focus indicator and drag resize', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-split-desktop-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-split-desktop-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const { device } = (await createRes.json()) as { device: { id: string } };

  try {
    await page.goto(`/devices/${device.id}`);

    // 打开即分屏：两 pane、一条垂直 gutter、恰好一个 active 标题栏（背景透明度区分焦点）
    await expect(page.getByTestId('split-terminal-area')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('split-pane')).toHaveCount(2);
    await expect(page.getByTestId('split-gutter')).toHaveCount(1);
    await expect(page.getByTestId('split-pane-titlebar')).toHaveCount(2);
    await expect(page.locator('[data-testid="split-pane-titlebar"][data-active]')).toHaveCount(1);

    const titlebars = page.getByTestId('split-pane-titlebar');
    for (let index = 0; index < (await titlebars.count()); index++) {
      const visual = await getVisualStyle(titlebars.nth(index));
      expect(hasVisiblePaint(visual.backgroundColor)).toBe(true);
    }

    const gutter = page.locator('[data-testid="split-gutter"][data-axis="x"]').first();
    const gutterVisual = await getVisualStyle(gutter);
    const gutterLineVisual = await getVisualStyle(gutter.locator(':scope > div'));
    expect(gutterVisual.width).toBeGreaterThan(0);
    expect(gutterLineVisual.width).toBeGreaterThan(0);
    expect(hasVisiblePaint(gutterLineVisual.backgroundColor)).toBe(true);

    const gutterBox = await gutter.boundingBox();
    if (!gutterBox) {
      throw new Error('Expected split gutter layout box');
    }
    const gutterStartX = gutterBox.x + gutterBox.width / 2;
    const gutterStartY = gutterBox.y + gutterBox.height / 2;
    await page.mouse.move(gutterStartX, gutterStartY);
    await page.mouse.down();
    try {
      await page.mouse.move(gutterStartX - 24, gutterStartY, { steps: 4 });
      await expect(page.getByTestId('split-drag-shield')).toBeVisible();
      const activeLine = gutter.locator(':scope > div');
      const referenceLine = gutter.locator('xpath=following-sibling::div');
      await expect
        .poll(async () => colorAlpha((await getVisualStyle(activeLine)).backgroundColor))
        .toBeGreaterThan(0.55);
      const activeAlpha = colorAlpha((await getVisualStyle(activeLine)).backgroundColor);
      const referenceAlpha = colorAlpha((await getVisualStyle(referenceLine)).backgroundColor);
      expect(activeAlpha).not.toBeNull();
      expect(referenceAlpha).not.toBeNull();
      expect(activeAlpha).toBeLessThan(1);
      expect(referenceAlpha).toBeLessThan(activeAlpha ?? 0);
    } finally {
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
      await page.mouse.up();
    }

    const panes = page.getByTestId('split-pane');
    const sourceTitlebar = panes.nth(0).getByTestId('split-pane-titlebar');
    const targetPane = panes.nth(1);
    const sourceBox = await sourceTitlebar.boundingBox();
    const targetBox = await targetPane.boundingBox();
    if (!sourceBox || !targetBox) {
      throw new Error('Expected split pane titlebar and target pane layout boxes');
    }

    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    try {
      await page.mouse.move(
        targetBox.x + targetBox.width * 0.1,
        targetBox.y + targetBox.height / 2,
        {
          steps: 8,
        }
      );
      const preview = page.getByTestId('split-pane-drop-preview');
      await expect(preview).toBeVisible();
      const previewVisual = await getVisualStyle(preview);
      expect(previewVisual.width).toBeGreaterThan(0);
      expect(previewVisual.height).toBeGreaterThan(0);
      expect(hasVisiblePaint(previewVisual.backgroundColor)).toBe(true);
    } finally {
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
      await page.mouse.up();
    }

    // 点击非焦点 pane：角标切换 + tmux active 同步
    const focusedBefore = await page
      .locator('[data-testid="split-pane"][data-focused]')
      .getAttribute('data-pane-id');
    const other = page.locator('[data-testid="split-pane"]:not([data-focused])').first();
    const otherPaneId = await other.getAttribute('data-pane-id');
    await other.click();
    await expect(
      page.locator(`[data-testid="split-pane"][data-focused][data-pane-id="${otherPaneId}"]`)
    ).toBeVisible({ timeout: 8000 });
    await expect
      .poll(() => tmux(`display-message -p -t ${sessionName} '#{pane_id}'`), { timeout: 8000 })
      .toBe(otherPaneId ?? '');
    expect(otherPaneId).not.toBe(focusedBefore);

    // 拖拽 gutter：两侧宽度互补变化
    const before = await waitForStablePaneWidths(sessionName);
    await page.mouse.move(gutterStartX, gutterStartY);
    await page.mouse.down();
    await page.mouse.move(gutterStartX - 120, gutterStartY, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        () => {
          const after = paneWidths(sessionName);
          const shrunk = paneIds.some((id) => (after[id] ?? 0) < (before[id] ?? 0));
          const grown = paneIds.some((id) => (after[id] ?? 0) > (before[id] ?? 0));
          return shrunk && grown;
        },
        { timeout: 10000 }
      )
      .toBe(true);

    // 标题栏 split down：第三个 pane 出现且布局出现垂直排列
    await page.getByTestId('split-down-button').click();
    await expect(page.getByTestId('split-pane')).toHaveCount(3, { timeout: 15000 });
    await expect
      .poll(() => tmux(`display-message -p -t ${sessionName} '#{window_layout}'`))
      .toContain('[');
  } finally {
    await request.delete(`/api/devices/${device.id}`);
    ensureCleanSession(sessionName);
  }
});
