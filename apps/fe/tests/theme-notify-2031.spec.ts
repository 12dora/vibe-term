import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// mode 2031 主题通知 e2e：pane 内 fake TUI（scripts/spike-theme/dump-tui.py，spike 阶段
// 实测过的受控程序）声明 CSI ?2031h 订阅后，前端 UI 切主题应让它收到 CSI ?997;{1|2}n
// 注入；同 session 未订阅的 idle shell pane 屏幕必须零污染（历史事故回归断言）。

test.use({ viewport: { width: 1280, height: 800 } });

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DUMP_TUI = path.join(REPO_ROOT, 'scripts/spike-theme/dump-tui.py');
const SUBSCRIBE_2031_HEX = '1b5b3f3230333168';
const NOTIFY_LIGHT_HEX = '1b5b3f3939373b326e';
const NOTIFY_DARK_HEX = '1b5b3f3939373b316e';

async function setThemeViaUI(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const isDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  const wantDark = theme === 'dark';
  if (isDark === wantDark) return;
  await page.getByTestId('theme-menu-trigger').click();
  await page.getByTestId(`theme-option-${theme}`).click();
  await expect(page.locator('html')).toHaveClass(wantDark ? /\bdark\b/ : /^[\s\S]*$(?<!\bdark\b)/);
}

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

function readRecvHex(logFile: string): string {
  try {
    return readFileSync(logFile, 'utf8')
      .split('\n')
      .map((line) => line.match(/^\d+ ([0-9a-f]+)$/)?.[1] ?? '')
      .join('');
  } catch {
    return '';
  }
}

test('theme-notify-2031: 订阅 pane 收到 997 通知，idle shell pane 零污染', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-2031-${Date.now()}`;
  const workDir = mkdtempSync(path.join(tmpdir(), 'tmex-2031-'));
  const logFile = path.join(workDir, 'tui.log');
  const { paneIds } = createTwoPaneSession(sessionName);
  const [tuiPane, idlePane] = paneIds as [string, string];

  const deviceId = await createDevice(request, sessionName, `e2e-2031-${Date.now()}`);
  // 双页：viewer 常驻设备页保持 gateway 对设备的连接；page 负责切主题
  // （切主题要 goto /settings，若同页离开设备页，广播时设备连接可能已释放）
  const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const viewer = await viewerContext.newPage();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    await viewer.goto(`/devices/${deviceId}`);
    await expect(viewer.getByTestId('device-page')).toBeVisible();
    await expect(viewer.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    // gateway attach 后再启动 fake TUI，订阅声明才会经 %output 被跟踪
    await page.waitForTimeout(1_000);

    tmux(
      `send-keys -t ${tuiPane} "python3 '${DUMP_TUI}' --log '${logFile}' --emit ${SUBSCRIBE_2031_HEX}" Enter`
    );
    await expect
      .poll(
        () => {
          try {
            return readFileSync(logFile, 'utf8').includes('EMIT');
          } catch {
            return false;
          }
        },
        { timeout: 10_000 }
      )
      .toBe(true);
    // 给 gateway 留时间消费 %output 里的订阅声明
    await page.waitForTimeout(500);

    const idleBefore = tmux(`capture-pane -p -t ${idlePane}`);

    await setThemeViaUI(page, 'light');
    await expect
      .poll(() => readRecvHex(logFile).includes(NOTIFY_LIGHT_HEX), { timeout: 10_000 })
      .toBe(true);

    await setThemeViaUI(page, 'dark');
    await expect
      .poll(() => readRecvHex(logFile).includes(NOTIFY_DARK_HEX), { timeout: 10_000 })
      .toBe(true);

    // 历史事故回归：未订阅的 idle shell pane 屏幕必须与切主题前完全一致
    await page.waitForTimeout(1_000);
    const idleAfter = tmux(`capture-pane -p -t ${idlePane}`);
    expect(idleAfter).toBe(idleBefore);
  } finally {
    await page.close();
    await viewerContext.close();
    await request.delete(`/api/devices/${deviceId}`);
    await request.post('/api/settings/theme', { data: { theme: 'dark' } });
    ensureCleanSession(sessionName);
    rmSync(workDir, { recursive: true, force: true });
  }
});
