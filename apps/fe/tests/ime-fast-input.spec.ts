import { expect, test } from '@playwright/test';
import {
  createLocalDevice,
  focusTerminal,
  readVisibleTerminalText,
  waitForCanvasTerminal,
} from './helpers/device';
import { createSinglePaneSession, ensureCleanSession, tmux } from './helpers/tmux';

// issue-45 bug 4-C e2e 骨架：模拟连续 5 个汉字的 IME 合成事件序列，断言终端 canvas
// 与 pty 都收到完整文本无丢字。当前主代码（terminal.ts:1409 syncTextareaPositionToCursor
// 调 updateRenderState 消费 dirty）会让某些字符在 rAF 渲染时漏画 → 测试 red。
// Task 9 改读 lastCursor 后转绿，再撤掉 test.fixme。
//
// 严格约束：IME 字符必须用合成 CompositionEvent 派发，**严禁 page.keyboard.type** 模拟
// （浏览器 keyboard API 无法触发真实 IME 候选词路径，会绕过 compositionstart/update/end
// 全部分支，等于没测到目标路径）。

test('issue45 ime fast input: composition events deliver 你好世界！ without missing chars', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-ime-fast-input-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const deviceId = await createLocalDevice(
    request,
    sessionName,
    `e2e-ime-fast-input-${Date.now()}`
  );

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page);
    await focusTerminal(page, { waitForTextarea: true });

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
});

function capturePaneText(sessionName: string): string {
  try {
    return tmux(`capture-pane -p -t ${sessionName}.0 -e -S -50`);
  } catch {
    return '';
  }
}
