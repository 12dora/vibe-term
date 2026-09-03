import { expect, test } from '@playwright/test';
import { setSiteTheme } from './helpers/site-theme';
import {
  createTwoPaneSession,
  ensureCleanSession,
  getPaneSize,
  getWindowSize,
} from './helpers/tmux';
import {
  KIND,
  attachCanonicalCommandCollector,
  decodeEnvelope,
  isGatewayWsUrl,
} from './helpers/ws-borsh';

async function readTerminalSize(page: import('@playwright/test').Page): Promise<{
  cols: number;
  rows: number;
} | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return { cols: term.cols, rows: term.rows };
  });
}

/**
 * 等前端 xterm 尺寸「落定」并与 tmux pane 对齐。
 * 只断言 term == pane 是不够的：xterm 挂载时会先以一个极小的初始尺寸出现（实测 20×24），
 * gateway 立刻把 tmux 同步成同样大小，一致性此刻就已成立；布局落定后才涨到真实尺寸（50×37）。
 * 拿前者当基线，后续 drift 断言测的全是首屏布局落定的假象（实测 pane 差 30 列 / window 差 72）。
 * 故要求尺寸连续两次采样不变，才认为可以取基线 / 判定收敛。
 */
async function waitForSettledTerminalSize(
  page: import('@playwright/test').Page,
  paneId: string
): Promise<void> {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const termSize = await readTerminalSize(page);
        if (!termSize) {
          previous = null;
          return 'terminal-unavailable';
        }
        const current = `${termSize.cols}x${termSize.rows}`;
        const unchanged = current === previous;
        previous = current;
        if (!unchanged) return `unsettled:${current}`;

        const paneSize = getPaneSize(paneId);
        const drift =
          Math.abs(termSize.cols - paneSize.cols) + Math.abs(termSize.rows - paneSize.rows);
        return drift <= 1
          ? 'settled'
          : `pane-mismatch:${current}/${paneSize.cols}x${paneSize.rows}`;
      },
      { timeout: 30_000 }
    )
    .toBe('settled');
}

// 尺寸命令统一走 canonical ResizePaneV11（change / resend 由 geometryReason 区分），
// 窗口样式仍是 tmux 控制面的 TMUX_SET_WINDOW_STYLE 帧。
function attachFrameCounter(page: import('@playwright/test').Page): {
  read: () => { resize: number; sync: number; windowStyle: number };
} {
  const commands = attachCanonicalCommandCollector(page);
  let windowStyle = 0;

  page.on('websocket', (ws) => {
    if (!isGatewayWsUrl(ws.url())) return;
    ws.on('framesent', ({ payload }) => {
      const envelope = decodeEnvelope(payload as Buffer);
      if (!envelope) return;
      if (envelope.kind === KIND.TMUX_SET_WINDOW_STYLE) windowStyle += 1;
    });
  });

  return {
    read() {
      const { change, resend } = commands.counts();
      return { resize: change, sync: resend, windowStyle };
    },
  };
}

test('ws-borsh: rapid theme toggle × browser resize converges back to window size + term/pane consistency', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-theme-resize-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[0];

  const name = `e2e-theme-resize-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const counter = attachFrameCounter(page);

  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await waitForSettledTerminalSize(page, targetPaneId);

    const windowSizeBefore = getWindowSize(sessionName);

    for (let i = 0; i < 4; i++) {
      const theme = i % 2 === 0 ? 'light' : 'dark';
      await setSiteTheme(theme);
      await page.waitForTimeout(50);
      await page.setViewportSize({
        width: 1200 + (i % 2 === 0 ? -50 : 50),
        height: 800 + (i % 2 === 0 ? -30 : 30),
      });
    }

    // 循环最后一次把 viewport 停在 1250×830，与初始 1200×800 下的尺寸直接比较没有意义；
    // 先回到初始 viewport，drift 断言才是「反复抖动后能否收敛回原尺寸」。
    await page.setViewportSize({ width: 1200, height: 800 });

    // 断言 1：前端 xterm 尺寸重新落定，且与 tmux pane 一致（与循环前同一套指标）。
    await waitForSettledTerminalSize(page, targetPaneId);

    // 断言 2：tmux window 整体网格回到循环前尺寸。
    // 这里刻意不断言单个 pane 的 cols/rows：产品把 window 网格 resize 到贴合视口，
    // 分屏比例由 tmux layout 自行决定，不在产品保证范围内。
    await expect
      .poll(
        () => {
          const windowSizeAfter = getWindowSize(sessionName);
          return (
            Math.abs(windowSizeAfter.cols - windowSizeBefore.cols) +
            Math.abs(windowSizeAfter.rows - windowSizeBefore.rows)
          );
        },
        { timeout: 20_000 }
      )
      .toBeLessThanOrEqual(2);

    const counts = counter.read();
    expect(counts.windowStyle).toBeGreaterThanOrEqual(1);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    await setSiteTheme('dark');
    ensureCleanSession(sessionName);
  }
});
