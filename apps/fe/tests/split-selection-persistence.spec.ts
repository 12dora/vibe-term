import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import {
  createFourPaneSession,
  createTwoPaneSession,
  createTwoWindowSession,
  ensureCleanSession,
  tmux,
} from './helpers/tmux';

// Bug 1 e2e：分屏下 A pane 持续输出触发 geometry effect → resize → clearSelectionState，
// 清掉 B pane 已建立的 selection。T7 修复（resize short-circuit + geometry effect 稳定化）
// 后，B pane selection 应在 A 持续输出期间持久保留。
//
// 焦点切换语义：分屏同窗切 pane 走轻量 FOCUS_PANE（不重建终端），selection 不应被清；
// 跨 window 切换重建终端，selection 被清（现有 expected 语义，由 terminal-selection-canvas
// .spec.ts 覆盖，此处只验证分屏内焦点切换不清 selection）。

test.use({ viewport: { width: 1280, height: 800 } });

type VisibleTextRange = {
  row: number;
  startCol: number;
  endCol: number;
};

async function createDevice(
  request: APIRequestContext,
  sessionName: string,
  name: string
): Promise<string> {
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  return created.device.id;
}

async function waitForSplitTerminal(page: Page, expectedPanes = 2): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.getByTestId('split-terminal-area')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('split-pane')).toHaveCount(expectedPanes, { timeout: 20_000 });
  await expect(page.locator('[data-terminal-engine] canvas').first()).toBeAttached({
    timeout: 20_000,
  });
  await page.waitForTimeout(2_000);
}

async function waitForCanvasInPane(page: Page, paneId: string): Promise<void> {
  await expect(
    page.locator(`[data-pane-id="${paneId}"] [data-terminal-engine] canvas`).first()
  ).toBeAttached({ timeout: 20_000 });
}

async function readVisibleTerminalTextByPane(page: Page, paneId: string): Promise<string> {
  // __tmexE2eXterm 是全局单例，分屏时只指向最后挂载的 pane；用 tmux capture-pane 直接
  // 读 pane 屏幕文本，不依赖前端 terminal 实例（更可靠，且 per-pane 准确）。
  void page;
  try {
    return tmux(`capture-pane -p -t ${paneId}`);
  } catch {
    return '';
  }
}

async function findVisibleTextRangeInPane(
  _page: Page,
  paneId: string,
  needle: string
): Promise<VisibleTextRange> {
  // 用 tmux capture-pane 找文本位置（不依赖 __tmexE2eXterm 全局单例）。
  // capture-pane 输出按行，row 是屏幕行号（从 0 开始）。
  const capture = tmux(`capture-pane -p -t ${paneId}`);
  const lines = capture.split('\n');
  for (let row = 0; row < lines.length; row++) {
    const startCol = lines[row]!.indexOf(needle);
    if (startCol >= 0) {
      return { row, startCol, endCol: startCol + needle.length - 1 };
    }
  }
  throw new Error(`visible text not found in pane ${paneId}: ${needle}`);
}

async function getCanvasMetricsInPane(
  page: Page,
  paneId: string
): Promise<{
  left: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
}> {
  // 从 DOM canvas bounding rect + tmux pane cols/rows 计算 cell 尺寸，
  // 不依赖 __tmexE2eXterm（分屏时全局单例只指向最后挂载的 pane）。
  const metrics = await page.evaluate((id) => {
    const paneEl = document.querySelector(`[data-pane-id="${id}"]`);
    if (!paneEl) return null;
    const canvas = paneEl.querySelector('.xterm canvas') as HTMLCanvasElement | null;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, paneId);

  if (!metrics) {
    throw new Error(`canvas metrics unavailable for pane ${paneId}`);
  }

  const [colsRaw, rowsRaw] = tmux(`display-message -p -t ${paneId} '#{pane_width}\t#{pane_height}'`)
    .split('\t')
    .map((v) => v.trim());
  const cols = Number.parseInt(colsRaw ?? '80', 10) || 80;
  const rows = Number.parseInt(rowsRaw ?? '24', 10) || 24;

  return {
    left: metrics.left,
    top: metrics.top,
    cellWidth: metrics.width / cols,
    cellHeight: metrics.height / rows,
  };
}

async function cellCenterInPane(
  page: Page,
  paneId: string,
  row: number,
  col: number
): Promise<{ x: number; y: number }> {
  const metrics = await getCanvasMetricsInPane(page, paneId);
  return {
    x: metrics.left + (col + 0.5) * metrics.cellWidth,
    y: metrics.top + (row + 0.5) * metrics.cellHeight,
  };
}

async function dragVisibleTextInPane(page: Page, paneId: string, needle: string): Promise<void> {
  const range = await findVisibleTextRangeInPane(page, paneId, needle);
  const start = await cellCenterInPane(page, paneId, range.row, range.startCol);
  const end = await cellCenterInPane(page, paneId, range.row, range.endCol);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function paneSelectionToolbarVisible(page: Page, paneId: string): Promise<boolean> {
  const locator = page.locator(
    `[data-pane-id="${paneId}"] [data-testid="terminal-selection-toolbar"]`
  );
  const count = await locator.count();
  if (count === 0) return false;
  return locator.first().isVisible();
}

test('bug1: split-pane B selection persists while A continuously outputs (5s / 15s / 30s)', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-bug1-persist-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const paneA = paneIds[0]!;
  const paneB = paneIds[1]!;

  const deviceId = await createDevice(request, sessionName, `e2e-bug1-persist-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForSplitTerminal(page);
    await waitForCanvasInPane(page, paneA);
    await waitForCanvasInPane(page, paneB);

    tmux(`send-keys -t ${paneB} "printf 'BUG1_SELECT_TARGET\\r\\n'" C-m`);
    await expect
      .poll(() => readVisibleTerminalTextByPane(page, paneB), { timeout: 20_000 })
      .toContain('BUG1_SELECT_TARGET');

    tmux(
      `send-keys -t ${paneA} "for i in $(seq 1 600); do echo \\"tick $i $(date +%s%N)\\"; sleep 0.1; done" C-m`
    );
    await page.waitForTimeout(800);

    await dragVisibleTextInPane(page, paneB, 'BUG1_SELECT_TARGET');
    await expect
      .poll(() => paneSelectionToolbarVisible(page, paneB), { timeout: 10_000 })
      .toBe(true);

    await page.waitForTimeout(5_000);
    expect(await paneSelectionToolbarVisible(page, paneB)).toBe(true);

    await page.waitForTimeout(10_000);
    expect(await paneSelectionToolbarVisible(page, paneB)).toBe(true);

    await page.waitForTimeout(15_000);
    expect(await paneSelectionToolbarVisible(page, paneB)).toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug1: 2x2 split — any pane output does not affect other panes selection', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-bug1-2x2-${Date.now()}`;
  const { paneIds } = createFourPaneSession(sessionName);
  expect(paneIds.length).toBe(4);

  const deviceId = await createDevice(request, sessionName, `e2e-bug1-2x2-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForSplitTerminal(page, 4);
    for (const pid of paneIds) {
      await waitForCanvasInPane(page, pid);
    }

    paneIds.forEach((pid, idx) => {
      tmux(`send-keys -t ${pid} "printf 'PANE${idx}_MARKER\\r\\n'" C-m`);
    });

    for (let idx = 0; idx < paneIds.length; idx++) {
      await expect
        .poll(() => readVisibleTerminalTextByPane(page, paneIds[idx]!), { timeout: 20_000 })
        .toContain(`PANE${idx}_MARKER`);
    }

    const targetPane = paneIds[0]!;
    await dragVisibleTextInPane(page, targetPane, 'PANE0_MARKER');
    await expect
      .poll(() => paneSelectionToolbarVisible(page, targetPane), { timeout: 10_000 })
      .toBe(true);

    for (let idx = 1; idx < 4; idx++) {
      const pid = paneIds[idx]!;
      tmux(
        `send-keys -t ${pid} "for i in $(seq 1 30); do echo \\"out $i $(date +%s%N)\\"; sleep 0.1; done" C-m`
      );
    }

    await page.waitForTimeout(4_000);

    expect(await paneSelectionToolbarVisible(page, targetPane)).toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug1: split-pane focus switch (same window) does not clear selection', async ({
  page,
  request,
}) => {
  // 分屏同窗切 pane 走轻量 FOCUS_PANE（不重建终端），selection 应保留。
  // 跨 window 切换清 selection 的语义由 terminal-selection-canvas.spec.ts 覆盖。
  const sessionName = `tmex-e2e-bug1-focus-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const paneA = paneIds[0]!;
  const paneB = paneIds[1]!;

  const deviceId = await createDevice(request, sessionName, `e2e-bug1-focus-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForSplitTerminal(page);
    await waitForCanvasInPane(page, paneA);
    await waitForCanvasInPane(page, paneB);

    tmux(`send-keys -t ${paneB} "printf 'FOCUS_SWITCH_TARGET\\r\\n'" C-m`);
    await expect
      .poll(() => readVisibleTerminalTextByPane(page, paneB), { timeout: 20_000 })
      .toContain('FOCUS_SWITCH_TARGET');

    const paneBLocator = page.locator(`[data-pane-id="${paneB}"]`);
    await paneBLocator.click();
    await expect
      .poll(() => page.locator(`[data-pane-id="${paneB}"][data-focused]`).count(), {
        timeout: 8_000,
      })
      .toBe(1);

    await dragVisibleTextInPane(page, paneB, 'FOCUS_SWITCH_TARGET');
    await expect
      .poll(() => paneSelectionToolbarVisible(page, paneB), { timeout: 10_000 })
      .toBe(true);

    const paneALocator = page.locator(`[data-pane-id="${paneA}"]`);
    await paneALocator.click();
    await expect
      .poll(() => page.locator(`[data-pane-id="${paneA}"][data-focused]`).count(), {
        timeout: 8_000,
      })
      .toBe(1);

    // 分屏同窗切焦点不重建终端，selection 保留
    await expect
      .poll(() => paneSelectionToolbarVisible(page, paneB), { timeout: 5_000 })
      .toBe(true);

    // 切回 B：点 titlebar 避免触发 canvas pointer down 清 selection
    await page.locator(`[data-pane-id="${paneB}"] [data-testid="split-pane-titlebar"]`).click();
    await expect
      .poll(() => page.locator(`[data-pane-id="${paneB}"][data-focused]`).count(), {
        timeout: 8_000,
      })
      .toBe(1);
    // selection 仍在（titlebar 点击不触发 canvas pointer down）
    expect(await paneSelectionToolbarVisible(page, paneB)).toBe(true);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug1: cross-window switch still clears selection (existing expected semantics)', async ({
  page,
  request,
}) => {
  // 跨 window 切换重建终端，selection 被清——这是现有 expected 语义，不应被 bug1 修复破坏。
  // 单 pane 视图（非分屏），用全局 __tmexE2eXterm 读 selection。
  const sessionName = `tmex-e2e-bug1-xwindow-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  const pane0 = paneIds[0]!;
  const pane1 = paneIds[1]!;
  const win0 = windowIds[0]!;
  const win1 = windowIds[1]!;

  const deviceId = await createDevice(request, sessionName, `e2e-bug1-xwindow-${Date.now()}`);

  async function readSelectionText(): Promise<string | null> {
    return page.evaluate(() => (window as any).__tmexE2eTerminalSelectionText ?? null);
  }

  async function readVisibleText(): Promise<string> {
    return page.evaluate(() => {
      const term = (window as any).__tmexE2eXterm;
      if (!term) return '';
      const buffer = term.buffer.active;
      const start = buffer.viewportY;
      const end = Math.min(buffer.length, start + term.rows);
      const lines: string[] = [];
      for (let y = start; y < end; y++) {
        const line = buffer.getLine(y);
        lines.push(line ? line.translateToString(false) : '');
      }
      return lines.join('\n');
    });
  }

  async function findVisibleTextRange(needle: string): Promise<VisibleTextRange> {
    const match = await page.evaluate((target) => {
      const term = (window as any).__tmexE2eXterm;
      if (!term) return null;
      const buffer = term.buffer.active;
      const start = buffer.viewportY;
      const end = Math.min(buffer.length, start + term.rows);
      for (let y = start; y < end; y++) {
        const line = buffer.getLine(y);
        const text = line ? line.translateToString(false) : '';
        const startCol = text.indexOf(target);
        if (startCol >= 0) {
          return { row: y - start, startCol, endCol: startCol + target.length - 1 };
        }
      }
      return null;
    }, needle);
    if (!match) throw new Error(`visible text not found: ${needle}`);
    return match;
  }

  async function getCanvasMetrics(): Promise<{
    left: number;
    top: number;
    cellWidth: number;
    cellHeight: number;
  }> {
    const metrics = await page.evaluate(() => {
      const term = (window as any).__tmexE2eXterm;
      const canvas = document.querySelector('.xterm canvas') as HTMLCanvasElement | null;
      if (!term || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const cell = term._core?._renderService?.dimensions?.css?.cell;
      return {
        left: rect.left,
        top: rect.top,
        cellWidth: Number(cell?.width ?? 0),
        cellHeight: Number(cell?.height ?? 0),
      };
    });
    if (!metrics) throw new Error('canvas metrics unavailable');
    return metrics;
  }

  async function dragVisibleText(needle: string): Promise<void> {
    const range = await findVisibleTextRange(needle);
    const metrics = await getCanvasMetrics();
    const start = {
      x: metrics.left + (range.startCol + 0.5) * metrics.cellWidth,
      y: metrics.top + (range.row + 0.5) * metrics.cellHeight,
    };
    const end = {
      x: metrics.left + (range.endCol + 0.5) * metrics.cellWidth,
      y: metrics.top + (range.row + 0.5) * metrics.cellHeight,
    };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
  }

  try {
    tmux(`send-keys -t ${pane0} "printf 'XWINDOW_TARGET\\r\\n'" C-m`);

    await page.goto(`/devices/${deviceId}/windows/${win0}/panes/${encodeURIComponent(pane0)}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleText(), { timeout: 20_000 }).toContain('XWINDOW_TARGET');

    await dragVisibleText('XWINDOW_TARGET');
    await expect
      .poll(async () => (await readSelectionText()) ?? '', { timeout: 10_000 })
      .toBe('XWINDOW_TARGET');

    await page.getByTestId(`window-item-${win1}`).click();
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect
      .poll(async () => (await readSelectionText()) ?? null, { timeout: 10_000 })
      .toBeNull();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
