import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createLocalDevice } from './helpers/device';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// 移动端：轻点 OSC 8 链接即打开，不唤起软键盘、不上报鼠标。

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const EXPLICIT_URL = 'https://example.com/osc8/mobile';

test('mobile terminal: 轻点 OSC 8 链接打开', async ({ page, request }) => {
  const sessionName = `vibeterm-e2e-hyperlinks-mobile-${Date.now()}`;
  createSinglePaneSession(sessionName);
  const sandbox = mkdtempSync(join(tmpdir(), 'vibeterm-e2e-hlink-m-'));
  const script = join(sandbox, 'link.sh');
  const deviceId = await createLocalDevice(
    request,
    sessionName,
    `e2e-hyperlinks-mobile-${Date.now()}`
  );
  await page.addInitScript(() => {
    (window as any).__e2eOpened = [];
    window.open = ((url?: string | URL) => {
      (window as any).__e2eOpened.push(String(url));
      return null;
    }) as typeof window.open;
  });

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm canvas').first()).toBeVisible({ timeout: 20_000 });
    writeFileSync(
      script,
      `clear\nprintf '%b\\n' 'MOB \\033]8;;${EXPLICIT_URL}\\033\\\\Tap Here\\033]8;;\\033\\\\'\n`
    );
    tmux(`send-keys -t ${sessionName} "sh ${script}" Enter`);

    const point = async (): Promise<{ x: number; y: number } | null> =>
      page.evaluate(() => {
        const term = (window as any).__vibetermE2eXterm;
        const canvas = document.querySelector('.xterm canvas');
        if (!term || !(canvas instanceof HTMLCanvasElement)) return null;
        const buffer = term.buffer.active;
        for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y += 1) {
          const text = buffer.getLine(y)?.translateToString(false) ?? '';
          const col = text.indexOf('Tap Here');
          if (col >= 0) {
            const rect = canvas.getBoundingClientRect();
            const cell = term._core?._renderService?.dimensions?.css?.cell;
            return {
              x: rect.left + (col + 2.5) * Number(cell?.width ?? 0),
              y: rect.top + (y - buffer.viewportY + 0.5) * Number(cell?.height ?? 0),
            };
          }
        }
        return null;
      });
    await expect.poll(point, { timeout: 15_000 }).not.toBeNull();
    const target = await point();
    if (!target) throw new Error('link not visible');

    await page.touchscreen.tap(target.x, target.y);
    await expect
      .poll(() => page.evaluate(() => [...((window as any).__e2eOpened as string[])]))
      .toEqual([EXPLICIT_URL]);
  } finally {
    await request.delete(`/api/devices/${deviceId}`).catch(() => {});
    ensureCleanSession(sessionName);
    rmSync(sandbox, { recursive: true, force: true });
  }
});
