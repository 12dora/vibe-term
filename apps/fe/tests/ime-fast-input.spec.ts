import { type APIRequestContext, expect, test, type Page } from '@playwright/test';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// issue-45 bug 4-C e2e 骨架：模拟连续 5 个汉字的 IME 合成事件序列，断言终端 canvas
// 与 pty 都收到完整文本无丢字。当前主代码（terminal.ts:1409 syncTextareaPositionToCursor
// 调 updateRenderState 消费 dirty）会让某些字符在 rAF 渲染时漏画 → 测试 red。
// Task 9 改读 lastCursor 后转绿，再撤掉 test.fixme。
//
// 严格约束：IME 字符必须用合成 CompositionEvent 派发，**严禁 page.keyboard.type** 模拟
// （浏览器 keyboard API 无法触发真实 IME 候选词路径，会绕过 compositionstart/update/end
// 全部分支，等于没测到目标路径）。

test(
  'issue45 ime fast input: composition events deliver 你好世界！ without missing chars',
  async ({ page, request }) => {
    const sessionName = `tmex-e2e-ime-fast-input-${Date.now()}`;
    createSinglePaneSession(sessionName);

    const deviceId = await createDevice(
      request,
      sessionName,
      `e2e-ime-fast-input-${Date.now()}`
    );

    try {
      await page.goto(`/devices/${deviceId}`);
      await waitForCanvasTerminal(page);
      await focusTerminalTextarea(page);

      // 用 page.evaluate 派发合成 CompositionEvent 序列：每个汉字走 start → update(s) → end。
      // 字符序列「你好世界！」分 5 次 composition 周期连续触发，覆盖 bug 4-C 的 rAF 漏画场景。
      await page.evaluate(() => {
        const g = globalThis as any;
        const term = g.__tmexE2eXterm;
        const textarea = term?.textarea as HTMLTextAreaElement | undefined;
        if (!term || !textarea) {
          throw new Error('terminal textarea not ready');
        }

        const chars = ['你', '好', '世', '界', '！'];
        for (const ch of chars) {
          textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
          textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: ch }));
          textarea.dispatchEvent(new CompositionEvent('compositionend', { data: ch }));
        }
      });

      // 断言 1：pty 收到完整文本（tmux capture-pane），证明 emitData 全部送达。
      await expect
        .poll(() => capturePaneText(sessionName), { timeout: 15_000 })
        .toContain('你好世界！');

      // 断言 2：终端 canvas 文本含完整序列（无空白），证明 rAF 渲染没漏画。
      // bug 路径会让某些汉字 dirty 被提前消费，导致 canvas 文本缺字。
      await expect
        .poll(() => readVisibleTerminalText(page), { timeout: 15_000 })
        .toContain('你好世界！');
    } finally {
      await request.delete(`/api/devices/${deviceId}`);
      ensureCleanSession(sessionName);
    }
  }
);

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

async function waitForCanvasTerminal(page: Page): Promise<void> {
  await expect(page.getByTestId('device-page')).toBeVisible();
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });
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

async function focusTerminalTextarea(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => Boolean((globalThis as any).__tmexE2eXterm?.textarea)),
      { timeout: 15_000 }
    )
    .toBeTruthy();
  await page.locator('.xterm').first().click();
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

function capturePaneText(sessionName: string): string {
  try {
    return tmux(`capture-pane -p -t ${sessionName}.0 -e -S -50`);
  } catch {
    return '';
  }
}
