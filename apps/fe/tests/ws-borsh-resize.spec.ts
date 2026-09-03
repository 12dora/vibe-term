import { type Page, expect, test } from '@playwright/test';
import {
  createSinglePaneSession,
  createTwoPaneSession,
  ensureCleanSession,
  getPaneSize,
} from './helpers/tmux';
import {
  CANONICAL_GEOMETRY_REASON_CHANGE,
  type CanonicalCommandCollector,
  attachCanonicalCommandCollector,
} from './helpers/ws-borsh';

async function readTerminalSize(page: Page): Promise<{
  cols: number;
  rows: number;
} | null> {
  return page.evaluate(() => {
    const term = (window as any).__tmexE2eXterm;
    if (!term) return null;
    return {
      cols: term.cols,
      rows: term.rows,
    };
  });
}

async function readTerminalPaneMatchState(page: Page, paneId: string): Promise<string> {
  const terminalSize = await readTerminalSize(page);
  const paneSize = getPaneSize(paneId);
  if (!terminalSize) {
    return 'terminal-unavailable';
  }

  const terminalKey = `${terminalSize.cols}x${terminalSize.rows}`;
  const paneKey = `${paneSize.cols}x${paneSize.rows}`;
  return terminalKey === paneKey ? 'match' : `terminal=${terminalKey};pane=${paneKey}`;
}

// legacy 的 TERM_RESIZE / TERM_SYNC_SIZE 两个 kind 已下线，两类语义现在由
// canonical ResizePaneV11 的 geometryReason 区分：change = 真实视口变化，
// resend = 焦点恢复/暖切换补发。
function attachResizeFrameCounter(page: Page): {
  reset: () => void;
  read: () => { resize: number; sync: number };
  commands: CanonicalCommandCollector;
} {
  const commands = attachCanonicalCommandCollector(page);
  return {
    reset() {
      commands.reset();
    },
    read() {
      const { change, resend } = commands.counts();
      return { resize: change, sync: resend };
    },
    commands,
  };
}

test('ws-borsh: resize does not spam canonical geometry-change commands', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-borsh-resize-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const counter = attachResizeFrameCounter(page);

  try {
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.getByTestId('terminal-shortcuts-strip')).toBeVisible();

    counter.reset();

    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForTimeout(800);

    expect(counter.read().resize <= 3).toBeTruthy();

    // 真实尺寸变化必须自增 sizeEpoch，网关才能丢弃过期尺寸
    const changeEpochs = counter.commands.resizes
      .filter((command) => command.reason === CANONICAL_GEOMETRY_REASON_CHANGE)
      .map((command) => command.sizeEpoch);
    for (let index = 1; index < changeEpochs.length; index += 1) {
      expect(changeEpochs[index] > changeEpochs[index - 1]).toBeTruthy();
    }
    for (const epoch of changeEpochs) expect(epoch > 0n).toBeTruthy();
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: initial load and browser resize converge to tmux pane size', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-sync-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[0];

  const name = `e2e-borsh-resize-sync-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => readTerminalPaneMatchState(page, targetPaneId), { timeout: 20_000 })
      .toBe('match');

    await page.setViewportSize({ width: 900, height: 700 });

    await expect
      .poll(() => readTerminalPaneMatchState(page, targetPaneId), { timeout: 20_000 })
      .toBe('match');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: growing viewport converges to latest tmux pane size instead of snapping back', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-grow-${Date.now()}`;
  const { paneIds } = createTwoPaneSession(sessionName);
  const targetPaneId = paneIds[0];

  const name = `e2e-borsh-resize-grow-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  try {
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.goto(`/devices/${deviceId}`);
    await expect(page.getByTestId('device-page')).toBeVisible();
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(() => readTerminalPaneMatchState(page, targetPaneId), { timeout: 20_000 })
      .toBe('match');

    await page.setViewportSize({ width: 3840, height: 2160 });

    await expect
      .poll(() => readTerminalPaneMatchState(page, targetPaneId), { timeout: 20_000 })
      .toBe('match');
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: remote tmux resize does not trigger resize echo from another browser', async ({
  browser,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-multi-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-borsh-resize-multi-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;

  const pageA = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const contextB = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pageB = await contextB.newPage();
  const counterA = attachResizeFrameCounter(pageA);
  const counterB = attachResizeFrameCounter(pageB);

  try {
    await Promise.all([pageA.goto(`/devices/${deviceId}`), pageB.goto(`/devices/${deviceId}`)]);
    await Promise.all([
      expect(pageA.getByTestId('device-page')).toBeVisible(),
      expect(pageB.getByTestId('device-page')).toBeVisible(),
      expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 20_000 }),
      expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 20_000 }),
    ]);

    await pageA.waitForTimeout(1_200);
    counterA.reset();
    counterB.reset();

    await pageA.setViewportSize({ width: 900, height: 700 });
    await pageA.waitForTimeout(1_500);

    expect(counterA.read().resize + counterA.read().sync).toBeLessThanOrEqual(4);
    expect(counterB.read()).toEqual({ resize: 0, sync: 0 });
  } finally {
    await pageA.close();
    await contextB.close();
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: focus restore emits no geometry command when terminal size is already current', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-focus-stable-${Date.now()}`;
  createTwoPaneSession(sessionName);

  const name = `e2e-borsh-resize-focus-stable-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const counter = attachResizeFrameCounter(page);

  try {
    await page.goto(`/devices/${deviceId}`);
    await Promise.all([
      expect(page.getByTestId('device-page')).toBeVisible(),
      expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 }),
    ]);

    await page.waitForTimeout(1_200);
    counter.reset();

    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(800);

    expect(counter.read()).toEqual({ resize: 0, sync: 0 });
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});

test('ws-borsh: focus restore resyncs one stale terminal without reintroducing resize loop', async ({
  page,
  request,
}) => {
  const sessionName = `tmex-e2e-resize-focus-stale-${Date.now()}`;
  createSinglePaneSession(sessionName);

  const name = `e2e-borsh-resize-focus-stale-${Date.now()}`;
  const createRes = await request.post('/api/devices', {
    data: { name, type: 'local', session: sessionName, authMode: 'auto' },
  });
  expect(createRes.ok()).toBeTruthy();
  const created = (await createRes.json()) as { device: { id: string } };
  const deviceId = created.device.id;
  const counter = attachResizeFrameCounter(page);

  try {
    await page.goto(`/devices/${deviceId}`);
    await Promise.all([
      expect(page.getByTestId('device-page')).toBeVisible(),
      expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 }),
    ]);

    await page.waitForTimeout(1_200);

    // 先做一次受控的真实尺寸变化并锁定它用掉的 epoch：随后的补发必须原样复用这个值
    const changeCommands = () =>
      counter.commands.resizes.filter(
        (command) => command.reason === CANONICAL_GEOMETRY_REASON_CHANGE
      );
    counter.reset();
    await page.setViewportSize({ width: 900, height: 700 });
    await expect.poll(() => changeCommands().length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const changeEpoch = changeCommands().at(-1)?.sizeEpoch;
    expect(changeEpoch).toBeDefined();

    // 只把本地模拟器改小（不动容器）：制造一个「尺寸没变但画面已陈旧」的跟随者
    await page.evaluate(() => {
      const term = (window as any).__tmexE2eXterm;
      if (!term) {
        throw new Error('missing e2e terminal');
      }
      const nextCols = Math.max(2, term.cols - 10);
      const nextRows = Math.max(2, term.rows - 5);
      term.resize(nextCols, nextRows);
      window.dispatchEvent(new Event('blur'));
    });
    await page.waitForTimeout(50);

    counter.reset();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForTimeout(800);

    const counts = counter.read();
    expect(counts.sync).toBeGreaterThanOrEqual(1);
    expect(counts.resize).toBe(0);
    expect(counts.sync).toBeLessThanOrEqual(2);
    // 补发复用当前 epoch（不自增），否则网关会把它当成新的视口声明
    const resends = counter.commands.resizes.filter(
      (command) => command.reason !== CANONICAL_GEOMETRY_REASON_CHANGE
    );
    expect(resends.length).toBeGreaterThanOrEqual(1);
    for (const command of resends) expect(command.sizeEpoch).toBe(changeEpoch as bigint);
  } finally {
    await request.delete(`/api/devices/${deviceId}`);
    ensureCleanSession(sessionName);
  }
});
