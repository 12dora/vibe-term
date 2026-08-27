import { type APIRequestContext, type Page, expect } from '@playwright/test';

// e2e 通用的设备创建 + 终端就绪/读屏/聚焦 helper。
// 各 spec 此前各自抄了一份，差异仅在设备名、renderer 探针、translateToString 的 trimRight，
// 这里统一为可参数化的实现，行为与各自原实现逐一对齐。

export async function createLocalDevice(
  request: APIRequestContext,
  sessionName: string,
  name = `${sessionName}-dev`
): Promise<string> {
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  return created.device.id;
}

export interface WaitForCanvasTerminalOptions {
  // 除 canvas 元素外，是否一并断言 __tmexE2eTerminalRenderer === 'canvas'
  requireCanvasRenderer?: boolean;
}

export async function waitForCanvasTerminal(
  page: Page,
  options: WaitForCanvasTerminalOptions = {}
): Promise<void> {
  const { requireCanvasRenderer = true } = options;

  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

  if (!requireCanvasRenderer) {
    await expect
      .poll(() => page.evaluate(() => Boolean(document.querySelector('.xterm canvas'))), {
        timeout: 20_000,
      })
      .toBe(true);
    return;
  }

  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          renderer: (window as any).__tmexE2eTerminalRenderer ?? null,
          hasCanvas: Boolean(document.querySelector('.xterm canvas')),
        })),
      { timeout: 20_000 }
    )
    .toEqual({ renderer: 'canvas', hasCanvas: true });
}

export interface ReadTerminalTextOptions {
  // 'viewport'：从 buffer.viewportY 起，跟随当前滚动位置；
  // 'screen'：从 buffer.baseY 起，恒取 tmux 视口对应的屏幕区。
  origin?: 'viewport' | 'screen';
  // translateToString 的 trimRight 参数，同时决定是否对每行再做 trimEnd。
  trim?: boolean;
}

export async function readTerminalLines(
  page: Page,
  options: ReadTerminalTextOptions = {}
): Promise<string[]> {
  const fromScreen = (options.origin ?? 'viewport') === 'screen';
  const trim = options.trim ?? false;

  return page.evaluate(
    (args) => {
      const term = (window as any).__tmexE2eXterm;
      if (!term) return [];

      const buffer = term.buffer.active;
      const start = args.fromScreen ? buffer.baseY : buffer.viewportY;
      const end = args.fromScreen ? start + term.rows : Math.min(buffer.length, start + term.rows);

      const lines: string[] = [];
      for (let y = start; y < end; y += 1) {
        const line = buffer.getLine(y);
        const text = line ? line.translateToString(args.trim) : '';
        lines.push(args.trim ? text.trimEnd() : text);
      }
      return lines;
    },
    { fromScreen, trim }
  );
}

export async function readVisibleTerminalText(
  page: Page,
  options: ReadTerminalTextOptions = {}
): Promise<string> {
  return (await readTerminalLines(page, options)).join('\n');
}

export interface FocusTerminalOptions {
  // 点击前先等 xterm textarea 挂载（IME 合成事件必须打在 textarea 上）
  waitForTextarea?: boolean;
}

export async function focusTerminal(page: Page, options: FocusTerminalOptions = {}): Promise<void> {
  if (options.waitForTextarea) {
    await expect
      .poll(() => page.evaluate(() => Boolean((globalThis as any).__tmexE2eXterm?.textarea)), {
        timeout: 15_000,
      })
      .toBeTruthy();
  }
  await page.locator('.xterm').first().click();
}
