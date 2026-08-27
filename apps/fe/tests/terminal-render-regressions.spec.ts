import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';
import { createLocalDevice, readTerminalLines } from './helpers/device';
import {
  createSinglePaneSession,
  createTwoWindowSession,
  ensureCleanSession,
  getPaneSize,
  tmux,
} from './helpers/tmux';

// 回归三连（0.16.4/0.16.5 用户报告）：
// 1. 冷启动直落单 pane 窗口，终端空白；
// 2. 切换到单 pane 窗口后，inline TUI（claude code 类）错位一行；
// 3. inline TUI 整视口重绘（超长选择列表）时内容错位。
// 统一强断言：前端终端视口逐行内容与 tmux capture-pane 一致、光标行一致。

async function readTerminalSize(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return { cols: term.cols, rows: term.rows };
  });
}

// 前端终端"屏幕"（buffer 末尾 rows 行，即 tmux 视口对应区域）逐行文本
async function readScreenLines(page: Page): Promise<string[]> {
  return readTerminalLines(page, { origin: 'screen', trim: true });
}

// ghostty-terminal 无 buffer.cursorY 兼容属性，读渲染缓存的视口光标（滚动在底部时
// 与 tmux #{cursor_y} 同坐标系）
async function readCursorRow(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    return term?.lastCursor?.y ?? null;
  });
}

// 调试用：controller 内部尺寸真相（JS rows vs WASM 渲染态）
async function readTerminalInternals(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return { missing: true };
    let scrollbar: unknown = null;
    try {
      scrollbar = term.bindings.readScrollbar(term.terminalHandle);
    } catch (e) {
      scrollbar = String(e);
    }
    return {
      cols: term.cols,
      rows: term.rows,
      lastViewportRows: term.lastViewportRows,
      renderedRowCount: term.lastRenderedRows?.length ?? null,
      bufferLength: term.buffer?.active?.length,
      baseY: term.buffer?.active?.baseY,
      viewportY: term.buffer?.active?.viewportY,
      lastCursor: term.lastCursor,
      scrollbar,
    };
  });
}

function capturePaneScreen(paneId: string): string[] {
  const raw = tmux(`capture-pane -p -t '${paneId}'`);
  return raw.split('\n').map((l) => l.trimEnd());
}

function capturePaneCursorRow(paneId: string): number {
  return Number(tmux(`display-message -p -t '${paneId}' '#{cursor_y}'`));
}

function diffScreens(feLines: string[], tmuxLines: string[], rows: number): string[] {
  const diffs: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    const fe = feLines[y] ?? '';
    const tm = tmuxLines[y] ?? '';
    if (fe !== tm) {
      diffs.push(`row ${y}: fe=${JSON.stringify(fe)} tmux=${JSON.stringify(tm)}`);
    }
  }
  return diffs;
}

// 断言失败时能看到两侧完整屏幕的对齐视图
function renderSideBySide(feLines: string[], tmuxLines: string[], rows: number): string {
  const out: string[] = [];
  for (let y = 0; y < rows; y += 1) {
    const fe = feLines[y] ?? '';
    const tm = tmuxLines[y] ?? '';
    out.push(
      `${fe === tm ? ' ' : '!'} ${String(y).padStart(2)} fe=${JSON.stringify(fe)} tmux=${JSON.stringify(tm)}`
    );
  }
  return out.join('\n');
}

// 截图终端区域并统计"非众数色"像素比例（在浏览器内解码，免 PNG 依赖）。
// 全空白画面该比例趋近 0。
async function measureInkRatio(page: Page): Promise<number> {
  const el = page.locator('.xterm').first();
  const shot = await el.screenshot();
  const b64 = shot.toString('base64');
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return -1;
    ctx.drawImage(img, 0, 0);
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map<number, number>();
    let total = 0;
    for (let i = 0; i < px.length; i += 4) {
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
    let modal = 0;
    for (const c of counts.values()) {
      if (c > modal) modal = c;
    }
    return total === 0 ? -1 : (total - modal) / total;
  }, b64);
}

// inline TUI 模拟器（claude code 风格：不进 alt-screen、不清屏，
// 相对光标移动重绘固定高度区块，SIGWINCH 时整块重绘；块尾不换行，
// 光标停在块底行尾，重绘用 CSI (N-1)F 回到块顶）。
// historyLines > 0 时先输出等量的超宽历史行（118 列），让窄↔宽 resize 触发真实 reflow。
function writeInlineTuiScript(lines: number, historyLines = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'tmex-e2e-tui-'));
  const path = join(dir, 'inline-tui.sh');
  writeFileSync(
    path,
    `#!/bin/sh
N=${lines}
H=${historyLines}
h=1
while [ "$h" -le "$H" ]; do
  printf 'HIST_%02d_' "$h"
  j=0
  while [ "$j" -lt 110 ]; do printf 'x'; j=$((j+1)); done
  printf '\\n'
  h=$((h+1))
done
frame=0
draw() {
  if [ "$frame" -gt 0 ]; then
    printf '\\033[%dF' "$((N-1))"
  fi
  i=1
  while [ "$i" -le "$N" ]; do
    printf '\\033[2KTUI_ROW_%02d_FRAME_%d' "$i" "$frame"
    if [ "$i" -lt "$N" ]; then
      printf '\\n'
    fi
    i=$((i+1))
  done
  frame=$((frame+1))
}
trap draw WINCH
echo TUI_START
draw
if [ "\${TUI_STDIN_DRIVEN:-0}" = "1" ]; then
  stty -echo
  while read -r _line; do
    draw
  done
else
  while :; do
    sleep 0.2 || true
  done
fi
`
  );
  return path;
}

test('bug1: cold start onto a single-pane window renders existing content', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-coldstart-${Date.now()}`;
  const { paneId, windowId } = createSinglePaneSession(sessionName);

  // 预先产生内容：滚动历史 + 结尾 marker，模拟已有工作现场
  tmux(
    `send-keys -t '${paneId}' "for i in $(echo 1); do seq 1 40; done; echo COLD_START_MARKER" C-m`
  );
  await expect.poll(() => capturePaneScreen(paneId).join('\n')).toContain('COLD_START_MARKER');

  const deviceId = await createLocalDevice(request, sessionName, `e2e-coldstart-${Date.now()}`);

  try {
    // 冷启动：首次导航直落具体 window/pane 深链接（刷新/书签/标签页恢复场景）
    await page.goto(`/devices/${deviceId}/windows/${windowId}/panes/${encodeURIComponent(paneId)}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    // 数据层：buffer 中必须出现 pane 已有内容
    await expect
      .poll(async () => (await readScreenLines(page)).join('\n'), { timeout: 20_000 })
      .toContain('COLD_START_MARKER');

    // 渲染层：画面不能是空白（数据到了但 canvas 没画同样算失败）
    await expect.poll(() => measureInkRatio(page), { timeout: 10_000 }).toBeGreaterThan(0.005);

    // 尺寸收敛后，前端屏幕与 tmux 视口一致
    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          const pane = getPaneSize(paneId);
          return pane.cols === term.cols && pane.rows === term.rows ? 'match' : 'pending';
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    const term = (await readTerminalSize(page)) as { cols: number; rows: number };
    await expect
      .poll(
        async () => diffScreens(await readScreenLines(page), capturePaneScreen(paneId), term.rows),
        { timeout: 10_000 }
      )
      .toEqual([]);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug2: switching to a single-pane window keeps inline TUI aligned', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-tui-align-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  const paneA = paneIds[0] as string;
  const paneB = paneIds[1] as string;
  const windowB = windowIds[1] as string;

  const deviceId = await createLocalDevice(request, sessionName, `e2e-tui-align-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    // 等窗口 A 尺寸收敛（device 级状态打满）
    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          const pane = getPaneSize(paneA);
          return pane.cols === term.cols && pane.rows === term.rows ? 'match' : 'pending';
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    // window B 与视口同尺寸（它此前就在本视口用过），起满屏 inline TUI：
    // TUI_START + rows 行块 = rows+1 行，正好 1 行 scrollback（claude code 清屏后
    // 重画的典型形态）。曾经的回归：切窗后首条 live 输出触发 scrollToTop 把视口
    // pin 在顶部，之后整个 TUI 恒定错位一行。
    const viewport = (await readTerminalSize(page)) as { cols: number; rows: number };
    tmux(`resize-window -t '${windowB}' -x ${viewport.cols} -y ${viewport.rows}`);
    await expect
      .poll(() => {
        const pane = getPaneSize(paneB);
        return `${pane.cols}x${pane.rows}`;
      })
      .toBe(`${viewport.cols}x${viewport.rows}`);

    const tuiScript = writeInlineTuiScript(viewport.rows);
    tmux(`send-keys -t '${paneB}' "TUI_STDIN_DRIVEN=1 sh ${tuiScript}" C-m`);
    await expect
      .poll(() => capturePaneScreen(paneB).join('\n'))
      .toContain(`TUI_ROW_${String(viewport.rows).padStart(2, '0')}_FRAME_0`);

    // 切换到窗口 B
    await expect(page.getByTestId(`window-item-${windowB}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`window-item-${windowB}`).click();

    // 等 B 收敛到视口尺寸
    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          const pane = getPaneSize(paneB);
          return pane.cols === term.cols && pane.rows === term.rows
            ? 'match'
            : `pane=${pane.cols}x${pane.rows};term=${term.cols}x${term.rows}`;
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    // 驱动一帧重绘（对应切窗后 claude code 的任意一次界面更新），
    // 确保 history 之后至少有一条 live 输出经过 onOutput 路径
    tmux(`send-keys -t '${paneB}' "n" C-m`);
    await expect
      .poll(() => capturePaneScreen(paneB).join('\n'), { timeout: 10_000 })
      .toMatch(/TUI_ROW_01_FRAME_[1-9]/);

    // 核心断言：前端屏幕与 tmux 视口逐行一致（错位一行在此暴露）
    const term = (await readTerminalSize(page)) as { cols: number; rows: number };
    await expect
      .poll(
        async () => {
          const fe = await readScreenLines(page);
          const tm = capturePaneScreen(paneB);
          const diffs = diffScreens(fe, tm, term.rows);
          if (diffs.length > 0) {
            console.log(
              `[bug2] internals=${JSON.stringify(await readTerminalInternals(page))} tmux cursor=${capturePaneCursorRow(paneB)}\n${renderSideBySide(fe, tm, term.rows)}`
            );
          }
          return diffs;
        },
        { timeout: 10_000 }
      )
      .toEqual([]);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug3: full-viewport inline TUI redraw stays aligned', async ({ page, request }) => {
  const sessionName = `tmex-e2e-fullredraw-${Date.now()}`;
  const { paneId } = createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-fullredraw-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          const pane = getPaneSize(paneId);
          return pane.cols === term.cols && pane.rows === term.rows ? 'match' : 'pending';
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    // 起一个"整视口高度"的 inline TUI（超长选择列表场景：重绘块占满 rows）
    const term = (await readTerminalSize(page)) as { cols: number; rows: number };
    const tuiScript = writeInlineTuiScript(term.rows);
    tmux(`send-keys -t '${paneId}' "sh ${tuiScript}" C-m`);
    await expect
      .poll(() => capturePaneScreen(paneId).join('\n'), { timeout: 10_000 })
      .toContain('TUI_ROW_01_FRAME_0');

    // 连续触发若干次整块重绘（SIGWINCH 驱动帧推进，模拟选项切换的整页刷新）
    for (let i = 0; i < 4; i += 1) {
      tmux(`resize-window -t '${sessionName}:0' -x ${term.cols - 1 - i} -y ${term.rows}`);
      await page.waitForTimeout(400);
    }
    tmux(`resize-window -t '${sessionName}:0' -x ${term.cols} -y ${term.rows}`);

    // 等前端与 tmux 尺寸重新一致后，全屏内容必须逐行一致
    await expect
      .poll(
        async () => {
          const t = await readTerminalSize(page);
          if (!t) return 'no-term';
          const pane = getPaneSize(paneId);
          return pane.cols === t.cols && pane.rows === t.rows ? 'match' : 'pending';
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    await expect
      .poll(
        async () => {
          const t = (await readTerminalSize(page)) as { cols: number; rows: number };
          const fe = await readScreenLines(page);
          const tm = capturePaneScreen(paneId);
          const diffs = diffScreens(fe, tm, t.rows);
          if (diffs.length > 0) {
            console.log(
              `[bug3] internals=${JSON.stringify(await readTerminalInternals(page))} tmux cursor=${capturePaneCursorRow(paneId)}\n${renderSideBySide(fe, tm, t.rows)}`
            );
          }
          return diffs;
        },
        { timeout: 10_000 }
      )
      .toEqual([]);

    const feCursor = await readCursorRow(page);
    expect(feCursor).toBe(capturePaneCursorRow(paneId));
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug3b: stdin-driven full-viewport inline TUI redraw stays aligned (no resize)', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-stdinredraw-${Date.now()}`;
  const { paneId } = createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-stdinredraw-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          const pane = getPaneSize(paneId);
          return pane.cols === term.cols && pane.rows === term.rows ? 'match' : 'pending';
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    // 尺寸稳定后起整视口高度 TUI，用 stdin 驱动帧推进（对应 /theme 里按方向键换选项）
    const term = (await readTerminalSize(page)) as { cols: number; rows: number };
    const tuiScript = writeInlineTuiScript(term.rows);
    tmux(`send-keys -t '${paneId}' "TUI_STDIN_DRIVEN=1 sh ${tuiScript}" C-m`);
    await expect
      .poll(() => capturePaneScreen(paneId).join('\n'), { timeout: 10_000 })
      .toContain('TUI_ROW_01_FRAME_0');

    for (let i = 1; i <= 6; i += 1) {
      tmux(`send-keys -t '${paneId}' "n" C-m`);
      await expect
        .poll(() => capturePaneScreen(paneId).join('\n'), { timeout: 5_000 })
        .toContain(`TUI_ROW_01_FRAME_${i}`);

      const diffs = await expect
        .poll(
          async () => {
            const fe = await readScreenLines(page);
            const tm = capturePaneScreen(paneId);
            const d = diffScreens(fe, tm, term.rows);
            if (d.length > 0) {
              console.log(
                `[bug3b frame ${i}] fe cursor=${await readCursorRow(page)} tmux cursor=${capturePaneCursorRow(paneId)}\n${renderSideBySide(fe, tm, term.rows)}`
              );
            }
            return d;
          },
          { timeout: 8_000 }
        )
        .toEqual([]);
      void diffs;
    }
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('bug4: remote resize (another client) rebuilds local screen aligned', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-remote-resize-${Date.now()}`;
  const { paneId, windowId } = createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(request, sessionName, `e2e-remote-resize-${Date.now()}`);

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          const pane = getPaneSize(paneId);
          return pane.cols === term.cols && pane.rows === term.rows ? 'match' : 'pending';
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    // 满屏 inline TUI（claude code 形态）
    const viewport = (await readTerminalSize(page)) as { cols: number; rows: number };
    const tuiScript = writeInlineTuiScript(viewport.rows);
    tmux(`send-keys -t '${paneId}' "TUI_STDIN_DRIVEN=1 sh ${tuiScript}" C-m`);
    await expect
      .poll(() => capturePaneScreen(paneId).join('\n'), { timeout: 10_000 })
      .toContain(`TUI_ROW_${String(viewport.rows).padStart(2, '0')}_FRAME_0`);

    // 另一客户端（手机等）把 window 改小并停住：TUI 收 WINCH 按新尺寸重绘。
    // 曾经的回归：前端只 term.resize 本地 reflow，与 tmux reflow 差一行后
    // TUI 相对移动重绘永久错位；正确行为是跟随尺寸并重拉 history 重建。
    const smallCols = viewport.cols - 20;
    const smallRows = viewport.rows - 8;
    tmux(`resize-window -t '${windowId}' -x ${smallCols} -y ${smallRows}`);
    await expect
      .poll(() => {
        const pane = getPaneSize(paneId);
        return `${pane.cols}x${pane.rows}`;
      })
      .toBe(`${smallCols}x${smallRows}`);

    // 前端应跟随远端尺寸且屏幕与 tmux 逐行一致（重建后）
    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'no-term';
          if (term.cols !== smallCols || term.rows !== smallRows) {
            return `term=${term.cols}x${term.rows}`;
          }
          const fe = await readScreenLines(page);
          const tm = capturePaneScreen(paneId);
          const diffs = diffScreens(fe, tm, term.rows);
          if (diffs.length > 0) {
            console.log(
              `[bug4] internals=${JSON.stringify(await readTerminalInternals(page))}\n${renderSideBySide(fe, tm, term.rows)}`
            );
            return diffs.slice(0, 3).join(' | ');
          }
          return 'aligned';
        },
        { timeout: 20_000 }
      )
      .toBe('aligned');

    // 之后的每帧重绘持续对齐（远端尺寸下驱动两帧）
    for (let i = 1; i <= 2; i += 1) {
      tmux(`send-keys -t '${paneId}' "n" C-m`);
      await expect
        .poll(
          async () => {
            const fe = await readScreenLines(page);
            const tm = capturePaneScreen(paneId);
            return diffScreens(fe, tm, smallRows);
          },
          { timeout: 8_000 }
        )
        .toEqual([]);
    }
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
