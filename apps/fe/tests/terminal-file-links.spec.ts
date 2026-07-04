import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// 终端文件链接：识别输出中的文件路径，结合授权根 + pane cwd 判定有效性，
// 有效文件路径与 URL 一样画虚线下划线，平台修饰键+点击跳转文件预览。
// e2e 浏览器 UA 为 Windows（见 terminal-selection-canvas.spec.ts 注释），修饰键为 Control。

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
    data: {
      name,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  return created.device.id;
}

async function waitForCanvasTerminal(page: Page): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          return {
            renderer: (window as any).__tmexE2eTerminalRenderer ?? null,
            hasCanvas: Boolean(document.querySelector('.xterm canvas')),
          };
        }),
      { timeout: 20_000 }
    )
    .toEqual({
      renderer: 'canvas',
      hasCanvas: true,
    });
}

async function findVisibleTextRange(page: Page, needle: string): Promise<VisibleTextRange | null> {
  return page.evaluate((target) => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) {
      return null;
    }

    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      const text = line ? line.translateToString(false) : '';
      const startCol = text.indexOf(target);
      if (startCol >= 0) {
        return {
          row: y - start,
          startCol,
          endCol: startCol + target.length - 1,
        };
      }
    }

    return null;
  }, needle);
}

async function waitForVisibleText(page: Page, needle: string): Promise<VisibleTextRange> {
  await expect.poll(() => findVisibleTextRange(page, needle), { timeout: 15_000 }).not.toBeNull();
  const range = await findVisibleTextRange(page, needle);
  if (!range) {
    throw new Error(`visible text not found: ${needle}`);
  }
  return range;
}

// 数 link 下划线层上该文本区间行带内的非透明像素（下划线用 stroke 画，alpha > 0 即有墨迹）。
async function countUnderlinePixels(page: Page, range: VisibleTextRange): Promise<number> {
  return page.evaluate((target) => {
    const term = (window as any).__tmexE2eXterm;
    const canvas = document.querySelector('.xterm canvas[data-layer="link"]');
    if (!term || !(canvas instanceof HTMLCanvasElement)) {
      return -1;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return -1;
    }

    const cell = term._core?._renderService?.dimensions?.css?.cell;
    const dpr = Math.max(1, globalThis.devicePixelRatio ?? 1);
    const cellWidth = Math.max(1, Math.round(Number(cell?.width ?? 0) * dpr));
    const cellHeight = Math.max(1, Math.round(Number(cell?.height ?? 0) * dpr));

    const x = target.startCol * cellWidth;
    const width = (target.endCol - target.startCol + 1) * cellWidth;
    const y = target.row * cellHeight;
    const data = context.getImageData(x, y, width, cellHeight).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) {
        count += 1;
      }
    }
    return count;
  }, range);
}

async function cellCenter(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  const metrics = await page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    const canvas = document.querySelector('.xterm canvas');
    if (!term || !(canvas instanceof HTMLCanvasElement)) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const cell = term._core?._renderService?.dimensions?.css?.cell;
    return {
      left: rect.left,
      top: rect.top,
      cellWidth: Number(cell?.width ?? 0),
      cellHeight: Number(cell?.height ?? 0),
    };
  });
  if (!metrics) {
    throw new Error('canvas metrics unavailable');
  }
  return {
    x: metrics.left + (col + 0.5) * metrics.cellWidth,
    y: metrics.top + (row + 0.5) * metrics.cellHeight,
  };
}

async function modifierClickText(page: Page, needle: string): Promise<void> {
  const range = await waitForVisibleText(page, needle);
  const target = await cellCenter(page, range.row, range.startCol + 1);
  await page.keyboard.down('Control');
  await page.mouse.click(target.x, target.y);
  await page.keyboard.up('Control');
}

test('terminal: 有效文件路径与 URL 画虚线下划线，修饰键点击跳文件预览', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-file-links-${Date.now()}`;
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-flink-')));
  writeFileSync(join(sandbox, 'hello.txt'), 'hello from file link');
  createSinglePaneSession(sessionName);

  const deviceId = await createDevice(request, sessionName, `e2e-file-links-${Date.now()}`);
  const rootRes = await request.post('/api/files/roots', {
    data: { deviceId, path: sandbox, enabled: true },
  });
  expect(rootRes.ok()).toBeTruthy();
  const rootId = (await rootRes.json()).root.id as string;

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    const filePath = `${sandbox}/hello.txt`;
    const ghostPath = `${sandbox}/ghost.txt`;
    tmux(
      `send-keys -t ${sessionName} "clear; echo GOOD ${filePath}; echo GHOST ${ghostPath}; echo MISS /nope/void.txt; echo LINK https://example.com/doc" Enter`
    );

    const goodRange = await waitForVisibleText(page, filePath);
    const missRange = await waitForVisibleText(page, '/nope/void.txt');
    const urlRange = await waitForVisibleText(page, 'https://example.com/doc');

    // 下划线重算有 150ms 节流，poll 等待终态。
    await expect
      .poll(() => countUnderlinePixels(page, goodRange), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(() => countUnderlinePixels(page, urlRange), { timeout: 10_000 })
      .toBeGreaterThan(0);
    // 不在任何授权根内的路径不画下划线。
    expect(await countUnderlinePixels(page, missRange)).toBe(0);

    // 授权根内但不存在的文件：有下划线，点击 stat 失败 → toast，不跳转。
    await modifierClickText(page, ghostPath);
    await expect(page.getByText('File does not exist or is not accessible')).toBeVisible({
      timeout: 10_000,
    });
    expect(page.url()).not.toContain('/file/');

    // 有效文件：点击跳转 /file/:ref 预览。
    await modifierClickText(page, filePath);
    await expect.poll(() => page.url(), { timeout: 10_000 }).toContain('/file/');
    await expect(page.getByText('hello from file link')).toBeVisible({ timeout: 15_000 });
  } finally {
    await request.delete(`/api/devices/${deviceId}`).catch(() => {});
    ensureCleanSession(sessionName);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('terminal: 相对路径基于 pane cwd 解析后画下划线', async ({ page, request }) => {
  const sessionName = `tmex-e2e-file-links-rel-${Date.now()}`;
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tmex-e2e-flink-rel-')));
  writeFileSync(join(sandbox, 'rel.txt'), 'rel');
  createSinglePaneSession(sessionName);

  const deviceId = await createDevice(request, sessionName, `e2e-file-links-rel-${Date.now()}`);
  const rootRes = await request.post('/api/files/roots', {
    data: { deviceId, path: sandbox, enabled: true },
  });
  expect(rootRes.ok()).toBeTruthy();

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);

    // 先 cd 进授权根，pane cwd 经 snapshot 同步到前端后，相对路径才可解析。
    tmux(`send-keys -t ${sessionName} "cd ${sandbox}" Enter`);
    tmux(`send-keys -t ${sessionName} "clear; echo REL ./rel.txt" Enter`);

    const relRange = await waitForVisibleText(page, './rel.txt');
    await expect
      .poll(() => countUnderlinePixels(page, relRange), { timeout: 15_000 })
      .toBeGreaterThan(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`).catch(() => {});
    ensureCleanSession(sessionName);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
