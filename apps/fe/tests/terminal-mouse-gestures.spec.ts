import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { ensureCleanSession, tmux } from './helpers/tmux';

// 鼠标手势补全回归（plan-01）：
// - Shift+左键拖拽在鼠标上报模式下走本地文本选择（xterm 约定），TUI 收不到事件；
// - 1003 any-event tracking 下裸悬停 motion 上报（SGR code 35），且同 cell 去重。

const ESC = String.fromCharCode(27);
const SGR_ANY_RE = new RegExp(`${ESC}\\[<\\d+;\\d+;\\d+[Mm]`, 'g');
const SGR_HOVER_MOTION_RE = new RegExp(`${ESC}\\[<35;\\d+;\\d+M`, 'g');

const TUI_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/issue45-mouse-tui.py'
);

function readLog(logPath: string): string {
  try {
    return readFileSync(logPath, 'latin1');
  } catch {
    return '';
  }
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

function createTuiSession(
  sessionName: string,
  logPath: string,
  extraArgs = ''
): { paneId: string; windowId: string } {
  ensureCleanSession(sessionName);
  tmux(
    `new-session -d -s ${sessionName} -x 120 -y 45 "python3 ${TUI_SCRIPT} ${logPath} --alt${extraArgs}"`
  );
  const paneId = tmux(`display-message -p -t ${sessionName} '#{pane_id}'`);
  const windowId = tmux(`display-message -p -t ${sessionName}:0 '#{window_id}'`);
  return { paneId, windowId };
}

async function createDevice(request: APIRequestContext, sessionName: string): Promise<string> {
  const createRes = await request.post('/api/devices', {
    data: {
      name: `${sessionName}-dev`,
      type: 'local',
      session: sessionName,
      authMode: 'auto',
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  return created.device.id;
}

test('desktop: shift+left drag bypasses reporting into local selection', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-shift-select-${Date.now()}`;
  const logPath = `/tmp/${sessionName}.log`;
  const { paneId, windowId } = createTuiSession(sessionName, logPath);
  await expect
    .poll(() => tmux(`display-message -p -t ${paneId} '#{mouse_button_flag}'`), {
      timeout: 20_000,
    })
    .toBe('1');
  const deviceId = await createDevice(request, sessionName);

  try {
    await page.goto(`/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('row 10');
    await waitFeButtonTracking(page);

    writeFileSync(logPath, '');
    const box = await page.locator('.xterm-screen').first().boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    // Shift+左键拖拽：本地选区出现、TUI 无任何 SGR 事件
    const y = box.y + box.height * 0.2;
    await page.keyboard.down('Shift');
    await page.mouse.move(box.x + 20, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const t = (window as any).__tmexE2eTerminal;
            return t?.getSelection?.() ?? '';
          }),
        { timeout: 5_000 }
      )
      .not.toBe('');
    expect([...readLog(logPath).matchAll(SGR_ANY_RE)].length).toBe(0);

    // 对照：无 Shift 的点击照常上报
    await page.mouse.click(box.x + 30, y, { delay: 30 });
    await expect
      .poll(() => [...readLog(logPath).matchAll(SGR_ANY_RE)].length, { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: bare hover motion reaches TUI under 1003 any-event tracking', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-hover-${Date.now()}`;
  const logPath = `/tmp/${sessionName}.log`;
  const { paneId, windowId } = createTuiSession(sessionName, logPath, ' --all');
  await expect
    .poll(() => tmux(`display-message -p -t ${paneId} '#{mouse_all_flag}'`), { timeout: 20_000 })
    .toBe('1');
  const deviceId = await createDevice(request, sessionName);

  try {
    await page.goto(`/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`);
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => readVisibleTerminalText(page), { timeout: 20_000 }).toContain('row 10');
    // 等 1003 恢复完成（authoritative modes 覆盖 mouseAny）
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const t = (window as any).__tmexE2eTerminal;
            return t?.exportModeSnapshot?.()?.mouseAny ?? false;
          }),
        { timeout: 15_000 }
      )
      .toBe(true);

    writeFileSync(logPath, '');
    const box = await page.locator('.xterm-screen').first().boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;

    // 裸悬停（不按键）划过多行：TUI 应收到 code 35 的 motion
    await page.mouse.move(box.x + 40, box.y + box.height * 0.2);
    await page.mouse.move(box.x + 200, box.y + box.height * 0.6, { steps: 10 });

    await expect
      .poll(() => [...readLog(logPath).matchAll(SGR_HOVER_MOTION_RE)].length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
