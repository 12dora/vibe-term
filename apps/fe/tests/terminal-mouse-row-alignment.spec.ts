import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

// bug 回归（2026070502-tui-mouse-drag-bugs）：Retina（dpr=2）下 cssCell 高按物理
// 像素网格对齐是 .5 步进（默认 13 × 1.2 = 15.6 → 15.5）。修复前 emitMouseInput
// 把 cell 尺寸 Math.round 成 16 再交给编码器，鼠标行号从视觉第 ~16 行起比渲染
// 网格少 1（opencode 全屏 TUI 下半屏点击/拖拽全偏一行）；渲染与文本选择 hitTest
// 用的都是未取整的 15.5，所以只有鼠标上报错位。
//
// dpr=1 时 cssCell 恰为整数、取整无损——这正是 issue45 时期诊断 spec 未复现的
// 原因，因此本 spec 固定 deviceScaleFactor=2。

const ESC = String.fromCharCode(27);
const SGR_PRESS_RE = new RegExp(`${ESC}\\[<0;(\\d+);(\\d+)M`, 'g');

const TUI_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/issue45-mouse-tui.py'
);

test.use({ deviceScaleFactor: 2 });

interface SgrPress {
  col: number;
  row: number;
}

function lastPress(logPath: string): SgrPress | null {
  let raw = '';
  try {
    raw = readFileSync(logPath, 'latin1');
  } catch {
    return null;
  }
  const presses = [...raw.matchAll(SGR_PRESS_RE)];
  const last = presses.at(-1);
  if (!last) return null;
  return { col: Number.parseInt(last[1] ?? '0', 10), row: Number.parseInt(last[2] ?? '0', 10) };
}

async function readCellDimensions(page: Page): Promise<{ width: number; height: number }> {
  const cell = await page.evaluate(() => {
    const term = (window as any).__tmexE2eTerminal ?? (window as any).__tmexE2eXterm;
    return term?.cellDimensions?.() ?? null;
  });
  expect(cell).toBeTruthy();
  return cell as { width: number; height: number };
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return '';
    const buffer = term.buffer.active;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length, start + term.rows);
    const lines: string[] = [];
    for (let y = start; y < end; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(false) : '');
    }
    return lines.join('\n');
  });
}

test('desktop dpr=2: mouse press row matches the rendered grid row on the lower half of the screen', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-mouse-row-${Date.now()}`;
  const logPath = `/tmp/tmex-e2e-mouse-row-${Date.now()}.log`;
  // 直接以 TUI 为 session 初始命令并给足行数：python TUI 不响应 WINCH 重绘，
  // 默认 80x24 会话只剩尾部 24 行可见（'row 10' 等不到）
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} -x 120 -y 45 "python3 ${TUI_SCRIPT} ${logPath} --alt"`);
  const paneId = tmux(`display-message -p -t ${sessionName} '#{pane_id}'`);
  const windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`);
  await expect
    .poll(
      () =>
        tmux(
          `display-message -p -t ${paneId} '#{alternate_on}#{mouse_button_flag}#{mouse_sgr_flag}'`
        ),
      { timeout: 20_000 }
    )
    .toBe('111');

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-mouse-row-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const panePath = `/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`;

  try {
    await page.goto(panePath);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('row 10');
    // 等权威模式恢复完成再点击（同 terminal-mouse-drag-recovery.spec.ts）
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const t = (window as any).__tmexE2eTerminal;
            return t?.exportModeSnapshot?.()?.mouseButton ?? false;
          }),
        { timeout: 15_000 }
      )
      .toBe(true);

    const cell = await readCellDimensions(page);
    // 前置：dpr=2 + 默认字号（13×1.2）下 cssCell 高必须是非整数（15.5），
    // 否则取整无损、本用例失去区分度。默认字号变更时需同步调整此处。
    expect(cell.height % 1).not.toBe(0);

    const screenBox = await page.locator('.xterm-screen').first().boundingBox();
    expect(screenBox).toBeTruthy();
    if (!screenBox) return;

    const paneRows = Math.floor(screenBox.height / cell.height);
    const rounded = Math.max(1, Math.round(cell.height));

    // 找出「取整 cell 高会算错行号」的视觉行（0-based）：修复前编码器收到 rounded，
    // floor((r+0.5)*cellH / rounded) !== r 的行必偏一行
    let mismatchRow = -1;
    for (let r = 1; r < paneRows - 1; r += 1) {
      const y = (r + 0.5) * cell.height;
      if (Math.floor(y / rounded) !== r) {
        mismatchRow = r;
        break;
      }
    }
    expect(mismatchRow).toBeGreaterThan(0);

    // sanity：上半屏（取整不影响的行）两版本都应正确
    const sanityRow = 2;
    for (const visualRow of [sanityRow, mismatchRow]) {
      writeFileSync(logPath, '');
      const clickX = screenBox.x + screenBox.width / 2;
      const clickY = screenBox.y + (visualRow + 0.5) * cell.height;
      await page.mouse.click(clickX, clickY, { delay: 40 });
      await expect.poll(() => lastPress(logPath), { timeout: 10_000 }).not.toBeNull();
      const press = lastPress(logPath);
      // SGR 行号 1-based：视觉 row r（0-based）→ SGR row r+1
      expect(press?.row).toBe(visualRow + 1);
    }
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
