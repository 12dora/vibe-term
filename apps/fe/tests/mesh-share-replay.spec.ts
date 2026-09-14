// 分享日志回放的 e2e：默认跑「左对齐、选区复制、墙钟」三项断言。
//
// 另有四个只由环境变量打开的排查模式，默认路径不受影响：
//   VIBETERM_E2E_REPLAY_WIDE_VIEWER=1  收件端用 2400×900 宽视口：录像（固定 220×50）窄于外框，
//                                      走的是居中那一支；默认视口下录像溢出，走贴左那一支。
//   VIBETERM_E2E_REPLAY_TUI=1          被分享端跑 fixtures/replay-tui-payload.sh（备用屏全屏 TUI）。
//   VIBETERM_E2E_REPLAY_CLAUDE=1       被分享端跑 claude，录一段真实 TUI。
//   VIBETERM_E2E_REPLAY_LOG_FILE=<f>   回放时用该 JSON 顶掉日志接口，复现线上录像。
// 后两者（以及给了 LOG_FILE 时）播到片尾后只截图到 SCREENSHOT_DIR，不跑后续断言。
// 截图默认落在 apps/fe/test-results/replay/，`VIBETERM_E2E_REPLAY_SHOTS` 可以改到别处。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, expect, test } from '@playwright/test';
import {
  type MeshState,
  loginWithPassword,
  meshTmux,
  meshUrl,
  readMeshState,
  readTerminalBuffer,
} from './helpers/mesh-e2e';

const SCREENSHOT_DIR =
  process.env.VIBETERM_E2E_REPLAY_SHOTS ??
  fileURLToPath(new URL('../test-results/replay/', import.meta.url));
const TUI_PAYLOAD = fileURLToPath(new URL('./fixtures/replay-tui-payload.sh', import.meta.url));
const MARKER = 'REPLAY-LEFT-EDGE-1';
const WIDE = `REPLAY-WIDE-${'W'.repeat(200)}`;
const WALL_CLOCK = /^\d{2}:\d{2}:\d{2}$/;

let state: MeshState;

test.beforeAll(() => {
  state = readMeshState();
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

interface ShareListBody {
  active: Array<{ id: string; url: string; viewers: number; state: string }>;
  history: Array<{ id: string; endReason: string | null; logBytes: number }>;
}

interface ShareLogBody {
  entries: Array<{ kind: string; data: string }>;
}

interface ReadOnlyProbeLine {
  text: string;
  index: number;
}

interface ReplayLayout {
  rootLeft: number;
  rootWidth: number;
  screenLeft: number;
  screenWidth: number;
  canvasLeft: number;
  panScrollLeft: number;
}

interface VisibleTextRange {
  row: number;
  startCol: number;
  endCol: number;
}

async function openRecipient(browser: Browser, url: string): Promise<Page> {
  const wideViewer = process.env.VIBETERM_E2E_REPLAY_WIDE_VIEWER === '1';
  const context = await browser.newContext(
    wideViewer ? { viewport: { width: 2400, height: 900 }, deviceScaleFactor: 2 } : {}
  );
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('share-password')).toBeVisible({ timeout: 30_000 });
  return page;
}

function startOwnSession(sessionName: string): void {
  spawnSync('sh', ['-c', `tmux -L ${state.entryTmuxSocket} kill-session -t ${sessionName}`], {
    stdio: 'ignore',
  });
  meshTmux(
    state.entryTmuxSocket,
    `new-session -d -x 220 -y 50 -s ${sessionName} "sh -lc 'exec sh'"`
  );
}

function stopOwnSession(sessionName: string): void {
  spawnSync('sh', ['-c', `tmux -L ${state.entryTmuxSocket} kill-session -t ${sessionName}`], {
    stdio: 'ignore',
  });
}

function sendReplayPayload(sessionName: string): void {
  const lines = [
    'REPLAY-LEFT-EDGE-1',
    'REPLAY-LEFT-EDGE-2',
    'REPLAY-LEFT-EDGE-3',
    'REPLAY-LEFT-EDGE-4',
    'REPLAY-LEFT-EDGE-5',
    WIDE,
  ].join('\\n');
  // `new-session -x 220 -y 50` 挡不住 attach：客户端一连上来 tmux 就把窗口改回客户端尺寸。
  // 录像宽度是这条用例的前提（窄录像走居中、宽录像走贴左），先钉死再发载荷。
  meshTmux(state.entryTmuxSocket, `set-window-option -t ${sessionName}:0 window-size manual`);
  meshTmux(state.entryTmuxSocket, `resize-window -t ${sessionName}:0 -x 220 -y 50`);
  if (process.env.VIBETERM_E2E_REPLAY_CLAUDE === '1') {
    meshTmux(
      state.entryTmuxSocket,
      `send-keys -t ${sessionName} "printf 'REPLAY-LEFT-EDGE-1\\n'; claude" C-m`
    );
    return;
  }
  if (process.env.VIBETERM_E2E_REPLAY_TUI === '1') {
    meshTmux(state.entryTmuxSocket, `send-keys -t ${sessionName} "sh ${TUI_PAYLOAD}" C-m`);
    return;
  }
  meshTmux(
    state.entryTmuxSocket,
    `send-keys -t ${sessionName} "printf '\\033[2J\\033[H${lines}\\n'" C-m`
  );
}

async function listShares(page: Page): Promise<ShareListBody> {
  const res = await page.request.get(meshUrl(state, '/api/share'));
  expect(res.ok(), `list shares: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as ShareListBody;
}

async function readShareLog(page: Page, shareId: string): Promise<ShareLogBody['entries']> {
  const res = await page.request.get(meshUrl(state, `/api/share/${shareId}/log?limit=500`));
  expect(res.ok(), `read share log: ${res.status()} ${await res.text()}`).toBeTruthy();
  return ((await res.json()) as ShareLogBody).entries;
}

function decodeLogData(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8');
}

async function readReplayLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = (
      window as unknown as {
        __vibetermE2eReadOnlyTerminal?: {
          buffer: {
            active: {
              length: number;
              getLine: (y: number) => { translateToString: (trim: boolean) => string } | null;
            };
          };
        };
      }
    ).__vibetermE2eReadOnlyTerminal;
    if (!term) return [];
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      const line = buffer.getLine(y);
      lines.push(line ? line.translateToString(false) : '');
    }
    return lines;
  });
}

async function findReplayMarkerLine(page: Page): Promise<ReadOnlyProbeLine | null> {
  const lines = await readReplayLines(page);
  let fallback: ReadOnlyProbeLine | null = null;
  for (const text of lines) {
    const index = text.indexOf(MARKER);
    if (index === 0) return { text, index };
    if (index >= 0 && fallback === null) fallback = { text, index };
  }
  return fallback;
}

async function dumpReplayDebug(page: Page): Promise<string> {
  const snapshot = await page.evaluate(() => {
    const g = window as unknown as {
      __vibetermE2eReadOnlyTerminal?: {
        cols?: number;
        rows?: number;
        buffer?: {
          active?: {
            length: number;
            getLine: (y: number) => { translateToString: (trim: boolean) => string } | null;
          };
        };
      };
    };
    const term = g.__vibetermE2eReadOnlyTerminal;
    const buffer = term?.buffer?.active;
    const lines: string[] = [];
    if (buffer) {
      for (let y = 0; y < Math.min(buffer.length, 40); y += 1) {
        const line = buffer.getLine(y);
        const text = line ? line.translateToString(true) : '';
        if (text) lines.push(text);
      }
    }
    return {
      hasProbe: Boolean(term),
      cols: term?.cols ?? null,
      rows: term?.rows ?? null,
      bufferLength: buffer?.length ?? 0,
      lines,
    };
  });
  return JSON.stringify(snapshot);
}

async function waitForReplayMarker(page: Page): Promise<ReadOnlyProbeLine> {
  try {
    await expect
      .poll(async () => (await findReplayMarkerLine(page))?.index ?? -1, { timeout: 30_000 })
      .toBe(0);
  } catch (error) {
    throw new Error(`replay marker missing: ${await dumpReplayDebug(page)}\n${String(error)}`);
  }
  const found = await findReplayMarkerLine(page);
  if (!found) throw new Error('replay buffer lost REPLAY-LEFT-EDGE-1 after poll');
  return found;
}

async function readReplayLayout(page: Page): Promise<ReplayLayout> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="share-replay-mount"]');
    if (!(root instanceof HTMLElement)) {
      return {
        rootLeft: Number.NaN,
        rootWidth: Number.NaN,
        screenLeft: Number.NaN,
        screenWidth: Number.NaN,
        canvasLeft: Number.NaN,
        panScrollLeft: Number.NaN,
      };
    }
    const screen = root.querySelector('.xterm-screen');
    const canvas = root.querySelector('canvas');
    const pan =
      root.querySelector('[data-pan-viewport="true"]') ?? root.querySelector('.xterm-viewport');
    const rootRect = root.getBoundingClientRect();
    const screenRect = screen instanceof HTMLElement ? screen.getBoundingClientRect() : null;
    return {
      rootLeft: rootRect.left,
      rootWidth: rootRect.width,
      screenLeft: screenRect ? screenRect.left : Number.NaN,
      screenWidth: screenRect ? screenRect.width : Number.NaN,
      canvasLeft: canvas instanceof HTMLElement ? canvas.getBoundingClientRect().left : Number.NaN,
      panScrollLeft: pan instanceof HTMLElement ? pan.scrollLeft : Number.NaN,
    };
  });
}

async function setReplaySpeed8x(page: Page): Promise<void> {
  const speed = page.getByTestId('share-replay-speed');
  for (let i = 0; i < 3; i += 1) {
    const label = (await speed.innerText()).trim();
    if (label.includes('8')) return;
    await speed.click();
  }
}

async function playReplayToEnd(page: Page): Promise<void> {
  await setReplaySpeed8x(page);
  const clock = page.getByTestId('share-replay-clock');
  const atEnd = async (): Promise<boolean> => {
    const text = (await clock.innerText()).trim();
    const parts = text.split('/').map((part) => part.trim());
    return parts.length === 2 && parts[0] === parts[1] && parts[0] !== '0:00';
  };
  if (await atEnd()) return;
  await page.getByTestId('share-replay-toggle').click();
  await expect.poll(atEnd, { timeout: 20_000 }).toBe(true);
}

async function dragScrubber(page: Page, ratio: number): Promise<void> {
  const box = await page.getByTestId('share-replay-scrubber').boundingBox();
  if (!box) throw new Error('share-replay-scrubber not visible');
  const x = box.x + Math.max(1, Math.min(box.width - 1, box.width * ratio));
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
}

async function findVisibleReplayRange(page: Page, needle: string): Promise<VisibleTextRange> {
  const handle = await page.waitForFunction(
    (target) => {
      const term = (
        window as unknown as {
          __vibetermE2eReadOnlyTerminal?: {
            rows: number;
            buffer: {
              active: {
                viewportY: number;
                length: number;
                getLine: (y: number) => { translateToString: (trim: boolean) => string } | null;
              };
            };
          };
        }
      ).__vibetermE2eReadOnlyTerminal;
      if (!term) return null;
      const buffer = term.buffer.active;
      const start = buffer.viewportY;
      const end = Math.min(buffer.length, start + term.rows);
      for (let y = start; y < end; y += 1) {
        const line = buffer.getLine(y);
        const text = line ? line.translateToString(false) : '';
        const startCol = text.indexOf(target);
        if (startCol >= 0) {
          return { row: y - start, startCol, endCol: startCol + target.length - 1 };
        }
      }
      return null;
    },
    needle,
    { timeout: 20_000 }
  );
  return (await handle.jsonValue()) as VisibleTextRange;
}

async function dragReplayText(page: Page, needle: string): Promise<void> {
  const range = await findVisibleReplayRange(page, needle);
  const point = await page.evaluate(({ row, startCol, endCol }) => {
    const root = document.querySelector('[data-testid="share-replay-mount"]');
    const term = (
      window as unknown as {
        __vibetermE2eReadOnlyTerminal?: {
          _core?: {
            _renderService?: {
              dimensions?: { css?: { cell?: { width: number; height: number } } };
            };
          };
          cellDimensions?: () => { width: number; height: number };
        };
      }
    ).__vibetermE2eReadOnlyTerminal;
    const canvas = root?.querySelector('canvas') ?? root?.querySelector('.xterm-screen');
    if (!term || !(canvas instanceof HTMLElement)) return null;
    const rect = canvas.getBoundingClientRect();
    const cell = term.cellDimensions?.() ?? term._core?._renderService?.dimensions?.css?.cell;
    if (!cell || cell.width <= 0 || cell.height <= 0) return null;
    return {
      startX: rect.left + (startCol + 0.5) * cell.width,
      startY: rect.top + (row + 0.5) * cell.height,
      endX: rect.left + (endCol + 0.5) * cell.width,
      endY: rect.top + (row + 0.5) * cell.height,
    };
  }, range);
  if (!point) throw new Error('replay cell metrics unavailable');
  await page.mouse.move(point.startX, point.startY);
  await page.mouse.down();
  await page.mouse.move(point.endX, point.endY, { steps: 12 });
  await page.mouse.up();
}

test.use(process.env.VIBETERM_E2E_REPLAY_WIDE_VIEWER === '1' ? { deviceScaleFactor: 2 } : {});

test('mesh: share replay renders from column 0, copies selection, and shows wall-clock time', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const sessionName = `vibeterm-share-replay-${Date.now()}`;
  startOwnSession(sessionName);
  let deviceId: string | undefined;
  let recipient: Page | undefined;

  try {
    await loginWithPassword(page, state);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: state.baseUrl,
    });

    const created = await page.request.post(meshUrl(state, '/api/devices'), {
      data: { name: sessionName, type: 'local', session: sessionName, authMode: 'auto' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    deviceId = ((await created.json()) as { device: { id: string } }).device.id;

    const settings = await page.request.put(meshUrl(state, '/api/share/settings'), {
      data: { defaultOrigin: state.baseUrl },
    });
    expect(settings.ok(), await settings.text()).toBeTruthy();

    await page.goto(meshUrl(state, `/devices/${deviceId}`), { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('share-open-button').click();
    await expect(page.getByTestId('share-create-form')).toBeVisible({ timeout: 15_000 });
    const password = await page.getByTestId('share-password').inputValue();
    await page.getByTestId('share-name').fill('e2e replay');
    await page.getByTestId('share-create-submit').click();
    await expect(page.getByTestId('share-active-view')).toBeVisible({ timeout: 15_000 });

    const listed = await listShares(page);
    const share = listed.active[0];
    expect(share).toBeTruthy();

    recipient = await openRecipient(browser, share.url);
    await recipient.getByTestId('share-password-input').fill(password);
    await recipient.getByTestId('share-password-submit').click();
    await expect(recipient.locator('.xterm').first()).toBeVisible({ timeout: 30_000 });

    // checkpoint 与后续 out 拉开墙钟差，拖动进度条时 HH:mm:ss 才会变。
    await page.waitForTimeout(2_000);
    sendReplayPayload(sessionName);

    if (process.env.VIBETERM_E2E_REPLAY_CLAUDE === '1') await page.waitForTimeout(15_000);
    else {
      await expect
        .poll(() => readTerminalBuffer(recipient as Page), { timeout: 30_000 })
        .toContain(MARKER);
    }
    await expect
      .poll(
        async () =>
          (await readShareLog(page, share.id))
            .filter((entry) => entry.kind === 'out')
            .map((entry) => decodeLogData(entry.data))
            .join(''),
        { timeout: 20_000 }
      )
      .toContain(MARKER);
    await page.waitForTimeout(2_000);

    const revoke = await page.request.post(meshUrl(state, `/api/share/${share.id}/revoke`));
    expect(revoke.ok(), await revoke.text()).toBeTruthy();
    await expect(recipient.getByTestId('share-ended')).toBeVisible({ timeout: 10_000 });

    await page.goto(meshUrl(state, '/settings?tab=share'), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(`share-history-row-${share.id}`)).toBeVisible({
      timeout: 30_000,
    });
    const logFile = process.env.VIBETERM_E2E_REPLAY_LOG_FILE;
    if (logFile) {
      const body = readFileSync(logFile, 'utf8');
      await page.route(/\/api\/share\/[^/]+\/log(\?.*)?$/, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body })
      );
    }
    const replayButton = page.getByTestId(`share-replay-${share.id}`);
    await expect(replayButton).toBeEnabled({ timeout: 15_000 });
    await replayButton.click();

    await expect(page.getByTestId('share-replay-dialog')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('share-replay-mount')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('share-replay-toggle')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('share-replay-dialog').locator('.animate-spin')).toHaveCount(0);

    await playReplayToEnd(page);
    if (
      process.env.VIBETERM_E2E_REPLAY_CLAUDE === '1' ||
      process.env.VIBETERM_E2E_REPLAY_LOG_FILE
    ) {
      await page.waitForTimeout(3_000);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/replay-claude.png` });
      return;
    }
    const markerLine = await waitForReplayMarker(page);
    expect(
      markerLine.index,
      `expected ${MARKER} at column 0, got ${JSON.stringify(markerLine)}`
    ).toBe(0);

    const layout = await readReplayLayout(page);
    expect(layout.panScrollLeft, `pan viewport scrollLeft=${layout.panScrollLeft}`).toBe(0);
    expect(layout.canvasLeft, `canvas left=${layout.canvasLeft}`).toBeGreaterThanOrEqual(
      layout.rootLeft - 0.5
    );
    // 真正的不变量：内容表面窄于外框时居中（margin:auto），溢出时自动边距归零、仍贴左。
    // 画布本来就该贴内容表面，不是贴外框——外框宽于录像时两者差的正是那半个空当。
    const centerOffset = Math.max(0, (layout.rootWidth - layout.screenWidth) / 2);
    expect(
      Math.abs(layout.screenLeft - layout.rootLeft - centerOffset),
      `screen left=${layout.screenLeft} root left=${layout.rootLeft} width ${layout.screenWidth}/${layout.rootWidth}`
    ).toBeLessThan(2);
    expect(
      Math.abs(layout.canvasLeft - layout.screenLeft),
      `canvas left=${layout.canvasLeft} screen left=${layout.screenLeft}`
    ).toBeLessThan(2);

    const wallAtEnd = (await page.getByTestId('share-replay-wall-clock').innerText()).trim();
    expect(wallAtEnd).toMatch(WALL_CLOCK);

    await page.screenshot({ path: `${SCREENSHOT_DIR}/replay-open.png` });

    await dragScrubber(page, 0);
    await expect
      .poll(async () => (await page.getByTestId('share-replay-wall-clock').innerText()).trim(), {
        timeout: 10_000,
      })
      .not.toBe(wallAtEnd);

    await playReplayToEnd(page);
    await waitForReplayMarker(page);
    await dragReplayText(page, MARKER);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as { __vibetermE2eReadOnlyTerminalSelectionText?: string | null })
                .__vibetermE2eReadOnlyTerminalSelectionText ?? null
          ),
        { timeout: 10_000 }
      )
      .toContain(MARKER);

    await expect(page.getByTestId('terminal-selection-copy')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/replay-selected.png` });
    await page.getByTestId('terminal-selection-copy').click();
    await expect
      .poll(() => page.evaluate(async () => navigator.clipboard.readText()), { timeout: 10_000 })
      .toContain(MARKER);
  } finally {
    await recipient?.context().close();
    if (deviceId)
      await page.request.delete(meshUrl(state, `/api/devices/${deviceId}`)).catch(() => undefined);
    stopOwnSession(sessionName);
  }
});
