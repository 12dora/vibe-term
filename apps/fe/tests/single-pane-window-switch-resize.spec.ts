import { type Page, expect, test } from '@playwright/test';
import { createTwoWindowSession, ensureCleanSession, getPaneSize, tmux } from './helpers/tmux';

async function readTerminalSize(page: Page): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return { cols: term.cols, rows: term.rows };
  });
}

// 回归：gateway 对 resize 做 per-device 去重时，切换到另一个单 pane window 后，
// post-select sync 上报的视口尺寸与 device 上次 resize 相同会被吞掉，
// 目标 window 保持旧尺寸、TUI 不触发 SIGWINCH 重绘。
// 正确语义：resize 去重必须以目标 window 的实际尺寸为准。
test('single-pane window switch resizes target window to webapp viewport', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-switch-resize-${Date.now()}`;
  const { paneIds, windowIds } = createTwoWindowSession(sessionName);
  expect(paneIds.length >= 2).toBeTruthy();

  const name = `e2e-switch-resize-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();

    // 等窗口 A 完成初始 resize：pane 尺寸收敛到 webapp 视口（也把 device 级尺寸状态打满）
    const paneA = paneIds[0] as string;
    const paneB = paneIds[1] as string;
    const windowB = windowIds[1] as string;

    await expect
      .poll(
        async () => {
          const term = await readTerminalSize(page);
          if (!term) return 'terminal-unavailable';
          const pane = getPaneSize(paneA);
          return pane.cols === term.cols && pane.rows === term.rows
            ? 'match'
            : `pane=${pane.cols}x${pane.rows};term=${term.cols}x${term.rows}`;
        },
        { timeout: 20_000 }
      )
      .toBe('match');

    const viewportSize = getPaneSize(paneA);
    expect(viewportSize.cols !== 60 || viewportSize.rows !== 18).toBeTruthy();

    // 外部把窗口 B 改成与视口不同的尺寸（模拟其他客户端 resize 过）
    tmux(`resize-window -t '${windowB}' -x 60 -y 18`);
    await expect
      .poll(() => {
        const pane = getPaneSize(paneB);
        return `${pane.cols}x${pane.rows}`;
      })
      .toBe('60x18');

    // webapp 内切换到窗口 B：必须触发 resize，使 B 收敛到视口尺寸
    await expect(page.getByTestId(`window-item-${windowB}`)).toBeVisible({ timeout: 20_000 });
    await page.getByTestId(`window-item-${windowB}`).click();

    await expect
      .poll(
        () => {
          const pane = getPaneSize(paneB);
          return `${pane.cols}x${pane.rows}`;
        },
        { timeout: 20_000 }
      )
      .toBe(`${viewportSize.cols}x${viewportSize.rows}`);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
