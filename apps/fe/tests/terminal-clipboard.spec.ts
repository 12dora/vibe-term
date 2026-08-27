import { expect, test } from '@playwright/test';
import {
  createLocalDevice,
  focusTerminal,
  readVisibleTerminalText,
  waitForCanvasTerminal,
} from './helpers/device';
import { createTwoPaneSession, ensureCleanSession, tmux } from './helpers/tmux';

const PASTE_SHORTCUT = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

// 该 spec 只要求 canvas 元素存在，不断言 renderer 探针（与原实现一致）
const CANVAS_ONLY = { requireCanvasRenderer: false };

test('desktop: paste shortcut should deliver clipboard text to the terminal', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-clipboard-paste-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const deviceId = await createLocalDevice(
    request,
    sessionName,
    `e2e-clipboard-paste-${Date.now()}`
  );

  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page, CANVAS_ONLY);

    await page.evaluate(async () => {
      await navigator.clipboard.writeText('echo paste_marker_123');
    });

    await focusTerminal(page);
    await page.keyboard.press(PASTE_SHORTCUT);

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 15_000 }).toContain(
      'echo paste_marker_123'
    );
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: Ctrl+C should interrupt the foreground process', async ({ page, request }) => {
  const sessionName = `tmex-e2e-clipboard-sigint-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const deviceId = await createLocalDevice(
    request,
    sessionName,
    `e2e-clipboard-sigint-${Date.now()}`
  );

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page, CANVAS_ONLY);

    tmux(`send-keys -t ${sessionName}.0 "sleep 60" C-m`);
    await page.waitForTimeout(500);

    await focusTerminal(page);
    await page.keyboard.press('Control+C');

    await focusTerminal(page);
    await page.keyboard.type('echo intr_done_456');
    await page.keyboard.press('Enter');

    await expect.poll(() => readVisibleTerminalText(page), { timeout: 15_000 }).toContain(
      'intr_done_456'
    );
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('desktop: Ctrl+B inside terminal should not toggle the sidebar', async ({ page, request }) => {
  const sessionName = `tmex-e2e-clipboard-prefix-${Date.now()}`;
  createTwoPaneSession(sessionName);
  const deviceId = await createLocalDevice(
    request,
    sessionName,
    `e2e-clipboard-prefix-${Date.now()}`
  );

  try {
    await page.goto(`/devices/${deviceId}`);
    await waitForCanvasTerminal(page, CANVAS_ONLY);

    const sidebar = page.locator('[data-slot="sidebar"][data-state]').first();
    const stateBefore = await sidebar.getAttribute('data-state');
    expect(stateBefore).toBeTruthy();

    await focusTerminal(page);
    await page.keyboard.press('Control+B');
    await page.waitForTimeout(300);

    expect(await sidebar.getAttribute('data-state')).toBe(stateBefore);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
