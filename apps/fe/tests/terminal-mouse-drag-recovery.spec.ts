import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import {
  createSinglePaneSession,
  createTwoWindowSession,
  ensureCleanSession,
  tmux,
} from './helpers/tmux';

// bug 回归（2026070502-tui-mouse-drag-bugs）：alt-screen TUI 开启 1002（按住拖拽
// motion 跟踪）+ 1006 后，刷新页面 / 切窗再切回都会走 capture 重建。capture 快照
// 不含 DECSET，鼠标模式必须由 gateway 随 TermHistory 用 tmux mouse_*_flag 权威
// 下发。修复前前端用硬编码 1000+1006 兜底 → 重建后只能点击（press/release）、
// 拖拽 motion 事件（SGR code 32+）永远发不出去。
//
// TUI 用 scripts/issue45-mouse-tui.py --alt：开 1049+1000+1002+1006，把收到的
// stdin 原样写日志，直接断言 TUI 实际收到的 SGR 字节流。

const ESC = String.fromCharCode(27);
const SGR_MOTION_RE = new RegExp(`${ESC}\\[<32;\\d+;\\d+M`, 'g');
const SGR_PRESS_RE = new RegExp(`${ESC}\\[<0;\\d+;\\d+M`, 'g');

const TUI_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/issue45-mouse-tui.py'
);

function motionEventCount(logPath: string): number {
  let raw = '';
  try {
    raw = readFileSync(logPath, 'latin1');
  } catch {
    return 0;
  }
  // 左键拖拽 motion：SGR code = 0(左键) + 32(motion)，可叠修饰键位仅在测试外部；
  // 这里只发裸左键，精确匹配 32
  return [...raw.matchAll(SGR_MOTION_RE)].length;
}

function pressEventCount(logPath: string): number {
  let raw = '';
  try {
    raw = readFileSync(logPath, 'latin1');
  } catch {
    return 0;
  }
  return [...raw.matchAll(SGR_PRESS_RE)].length;
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

// 等前端模式恢复完成（TermHistory 携带的权威位图已应用）再拖拽：修复前
// mouseButton 永远不会为 true，此断言即回归红线；同时避免拖拽早于连接就绪。
async function waitFeButtonTracking(page: Page): Promise<void> {
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
}

async function dragInsideTerminal(page: Page): Promise<void> {
  const screen = page.locator('.xterm-screen').first();
  const box = await screen.boundingBox();
  expect(box).toBeTruthy();
  if (!box) return;

  const startX = box.x + box.width * 0.3;
  const startY = box.y + box.height * 0.4;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY + 60, { steps: 8 });
  await page.mouse.up();
}

// 直接以 TUI 为 session 初始命令并给足行数（-y 45）：python TUI 打印 40 行锚点后
// 不响应 WINCH 重绘，默认 80x24 会话只剩尾部 24 行可见，'row 10' 永远等不到。
function createTuiSession(
  sessionName: string,
  logPath: string
): {
  paneId: string;
  windowId: string;
} {
  ensureCleanSession(sessionName);
  tmux(`new-session -d -s ${sessionName} -x 120 -y 45 "python3 ${TUI_SCRIPT} ${logPath} --alt"`);
  const paneId = tmux(`display-message -p -t ${sessionName} '#{pane_id}'`);
  const windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`);
  return { paneId, windowId };
}

async function waitButtonTracking(paneId: string): Promise<void> {
  await expect
    .poll(
      () =>
        tmux(
          `display-message -p -t ${paneId} '#{alternate_on}#{mouse_button_flag}#{mouse_sgr_flag}'`
        ),
      { timeout: 20_000 }
    )
    .toBe('111');
}

test('desktop: 1002 drag tracking survives page refresh (authoritative mode restore)', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-drag-refresh-${Date.now()}`;
  const logPath = `/tmp/tmex-e2e-drag-refresh-${Date.now()}.log`;
  const { paneId, windowId } = createTuiSession(sessionName, logPath);
  await waitButtonTracking(paneId);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-drag-refresh-${Date.now()}`,
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

    // 初始 attach：capture 重建应已恢复 1002，拖拽 motion 必须到达 TUI
    await waitFeButtonTracking(page);
    await dragInsideTerminal(page);
    await expect.poll(() => motionEventCount(logPath), { timeout: 10_000 }).toBeGreaterThan(0);

    // 刷新 → capture 重建 → 拖拽 motion 仍须到达
    writeFileSync(logPath, '');
    await page.reload();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('row 10');

    await waitFeButtonTracking(page);
    await dragInsideTerminal(page);
    await expect.poll(() => pressEventCount(logPath), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => motionEventCount(logPath), { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: 1002 drag tracking survives window round-trip', async ({ page, request }) => {
  const sessionName = `tmex-e2e-drag-window-${Date.now()}`;
  const logPath = `/tmp/tmex-e2e-drag-window-${Date.now()}.log`;
  const { paneId: tuiPaneId, windowId: tuiWindowId } = createTuiSession(sessionName, logPath);
  tmux(`new-window -t ${sessionName} "sh -lc 'echo PANE1_READY; exec sh'"`);
  const otherWindowId = tmux(`display-message -p -t ${sessionName}:1 '#{window_id}'`);
  const otherPaneId = tmux(`display-message -p -t ${sessionName}:1 '#{pane_id}'`);
  tmux(`select-window -t ${sessionName}:0`);
  expect(tuiPaneId && tuiWindowId && otherPaneId && otherWindowId).toBeTruthy();
  await waitButtonTracking(tuiPaneId);

  const createRes = await request.post('/api/devices', {
    data: {
      name: `e2e-drag-window-${Date.now()}`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const tuiPath = `/devices/${deviceId}/windows/${tuiWindowId}/panes/${encodeURIComponent(tuiPaneId)}`;
  const otherPath = `/devices/${deviceId}/windows/${otherWindowId}/panes/${encodeURIComponent(otherPaneId)}`;

  try {
    await page.goto(tuiPath);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('row 10');

    await waitFeButtonTracking(page);
    await dragInsideTerminal(page);
    await expect.poll(() => motionEventCount(logPath), { timeout: 10_000 }).toBeGreaterThan(0);

    // 切到另一个 window 再切回（完整 select barrier + capture 重建）
    await page.goto(otherPath);
    await expect
      .poll(() => readVisibleTerminalText(page), { timeout: 20_000 })
      .toContain('PANE1_READY');

    writeFileSync(logPath, '');
    await page.goto(tuiPath);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('row 10');

    await waitFeButtonTracking(page);
    await dragInsideTerminal(page);
    await expect.poll(() => pressEventCount(logPath), { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => motionEventCount(logPath), { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
