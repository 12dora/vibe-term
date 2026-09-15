// 分享日志回放的 e2e：默认跑「铺满外框、左对齐、选区复制、墙钟」四项断言。
//
// 另有四个只由环境变量打开的排查模式，默认路径不受影响：
//   VIBETERM_E2E_REPLAY_WIDE_VIEWER=1  收/发两端都用 2400×900 宽视口 + dpr 2：回放外框变大，
//                                      仿真网格跟着外框长大（录像 220×50 只是下界），整屏装得下。
//   VIBETERM_E2E_REPLAY_TUI=1          被分享端跑 fixtures/replay-tui-payload.sh（备用屏全屏 TUI）。
//   VIBETERM_E2E_REPLAY_CLAUDE=1       被分享端跑 claude，录一段真实 TUI。
//   VIBETERM_E2E_REPLAY_LOG_FILE=<f>   回放时用该 JSON 顶掉日志接口，复现线上录像。
// 后两者（以及给了 LOG_FILE 时）播到片尾后只截图到 SCREENSHOT_DIR，不跑后续断言。
// 截图默认落在 apps/fe/test-results/replay/，`VIBETERM_E2E_REPLAY_SHOTS` 可以改到别处。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { clickConsoleMoreItem } from './helpers/console-more';
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
/** 分享之前先打两行：快照本身就带上多行正文，才验得到裸 LF 有没有补 CR。 */
const CHECKPOINT_LINES = ['CKPT-LINE-1', 'CKPT-LINE-2'];
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
  entries: Array<{ kind: string; data: string; cols?: number; rows?: number }>;
}

interface ReadOnlyProbeLine {
  text: string;
  index: number;
}

interface ReplayLayout {
  rootLeft: number;
  rootTop: number;
  rootWidth: number;
  rootHeight: number;
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
  screenHeight: number;
  canvasLeft: number;
  panScrollLeft: number;
  cellWidth: number;
  cellHeight: number;
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

/** 分享前先往 pane 里打两行，让开分享时抓的快照里有多行正文。 */
function sendPreShareLines(sessionName: string): void {
  meshTmux(
    state.entryTmuxSocket,
    `send-keys -t ${sessionName} "printf '${CHECKPOINT_LINES.join('\\n')}\\n'" C-m`
  );
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

function paneSize(sessionName: string): { cols: number; rows: number } {
  const [cols, rows] = meshTmux(
    state.entryTmuxSocket,
    `display-message -p -t ${sessionName}:0 '#{pane_width}x#{pane_height}'`
  )
    .split('x')
    .map(Number);
  return { cols, rows };
}

async function assertRecordsTmuxResize(
  page: Page,
  shareId: string,
  sessionName: string
): Promise<void> {
  const before = paneSize(sessionName);
  const target = { cols: before.cols - 20, rows: before.rows - 6 };
  meshTmux(
    state.entryTmuxSocket,
    `resize-window -t ${sessionName}:0 -x ${target.cols} -y ${target.rows}`
  );
  await expect.poll(() => paneSize(sessionName), { timeout: 5_000 }).not.toEqual(before);
  const after = paneSize(sessionName);
  await expect
    .poll(
      async () =>
        (await readShareLog(page, shareId))
          .filter((entry) => entry.kind === 'resize')
          .map((entry) => `${entry.cols}x${entry.rows}`),
      { timeout: 20_000 }
    )
    .toContain(`${after.cols}x${after.rows}`);
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
        rootTop: Number.NaN,
        rootWidth: Number.NaN,
        rootHeight: Number.NaN,
        screenLeft: Number.NaN,
        screenTop: Number.NaN,
        screenWidth: Number.NaN,
        screenHeight: Number.NaN,
        canvasLeft: Number.NaN,
        panScrollLeft: Number.NaN,
        cellWidth: Number.NaN,
        cellHeight: Number.NaN,
      };
    }
    const term = (
      window as unknown as {
        __vibetermE2eReadOnlyTerminal?: {
          cellDimensions?: () => { width: number; height: number };
        };
      }
    ).__vibetermE2eReadOnlyTerminal;
    const cell = term?.cellDimensions?.() ?? null;
    const screen = root.querySelector('.xterm-screen');
    const canvas = root.querySelector('canvas');
    const pan =
      root.querySelector('[data-pan-viewport="true"]') ?? root.querySelector('.xterm-viewport');
    const rootRect = root.getBoundingClientRect();
    const screenRect = screen instanceof HTMLElement ? screen.getBoundingClientRect() : null;
    return {
      rootLeft: rootRect.left,
      rootTop: rootRect.top,
      rootWidth: rootRect.width,
      rootHeight: rootRect.height,
      screenLeft: screenRect ? screenRect.left : Number.NaN,
      screenTop: screenRect ? screenRect.top : Number.NaN,
      screenWidth: screenRect ? screenRect.width : Number.NaN,
      screenHeight: screenRect ? screenRect.height : Number.NaN,
      canvasLeft: canvas instanceof HTMLElement ? canvas.getBoundingClientRect().left : Number.NaN,
      panScrollLeft: pan instanceof HTMLElement ? pan.scrollLeft : Number.NaN,
      cellWidth: cell ? cell.width : Number.NaN,
      cellHeight: cell ? cell.height : Number.NaN,
    };
  });
}

/** 内容表面的位置与尺寸；比较「开窗那一刻」和「稳定之后」是否跳变。 */
function screenRectOf(layout: ReplayLayout): string {
  return `${Math.round(layout.screenLeft - layout.rootLeft)},${Math.round(
    layout.screenTop - layout.rootTop
  )} ${Math.round(layout.screenWidth)}×${Math.round(layout.screenHeight)}`;
}

/**
 * 开窗那一刻与稳定之后的内容表面必须是同一块（同一字号、同一网格）。
 * 容差一个 cell：首帧画完之前 `.xterm-screen` 还是 `width:100%`，落到「网格 × cell」时
 * 会差掉最后那点取整余数——那不是尺寸跳变。
 */
function expectNoScreenJump(opened: ReplayLayout, settled: ReplayLayout): void {
  const detail = `screen rect ${screenRectOf(opened)} → ${screenRectOf(settled)}`;
  expect(Math.abs(settled.screenWidth - opened.screenWidth), detail).toBeLessThanOrEqual(
    Math.max(settled.cellWidth, 1) + 1
  );
  expect(Math.abs(settled.screenHeight - opened.screenHeight), detail).toBeLessThanOrEqual(
    Math.max(settled.cellHeight, 1) + 1
  );
  expect(Math.abs(settled.screenLeft - opened.screenLeft), detail).toBeLessThan(2);
  expect(Math.abs(settled.screenTop - opened.screenTop), detail).toBeLessThan(2);
}

/**
 * 等只读终端这一台实例稳定下来。开窗时只会开一台（字号与网格先算好再挂终端），但外框变化
 * 或日志翻页让包络变大时仍可能换字号重建：重建那一下清屏并从 checkpoint 重放，
 * 正赶上拖选就会把选区弄丢。给当前实例打个标记，隔一会儿再看标记还在不在——在就是没换过。
 */
async function waitForReplayTerminalSettled(page: Page): Promise<void> {
  const tag = async (): Promise<boolean> =>
    page.evaluate(() => {
      const term = (
        window as unknown as { __vibetermE2eReadOnlyTerminal?: { __e2eSettleTag?: number } }
      ).__vibetermE2eReadOnlyTerminal;
      if (!term) return false;
      term.__e2eSettleTag = 1;
      return true;
    });
  const stillTagged = async (): Promise<boolean> =>
    page.evaluate(() => {
      const term = (
        window as unknown as { __vibetermE2eReadOnlyTerminal?: { __e2eSettleTag?: number } }
      ).__vibetermE2eReadOnlyTerminal;
      return term?.__e2eSettleTag === 1;
    });
  await expect
    .poll(
      async () => {
        if (!(await tag())) return false;
        await page.waitForTimeout(500);
        return stillTagged();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

/** 快照那几行里有多少行真的贴在第 0 列（命令回显那一行不算，它前面有提示符）。 */
async function countCheckpointLinesAtColumnZero(page: Page): Promise<number> {
  const lines = await readReplayLines(page);
  return CHECKPOINT_LINES.filter((needle) => lines.some((line) => line.startsWith(needle))).length;
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

// 宽视口模式：录像端（收件人）与回放端（自己）都放大。回放窗是按自己这边的视口算尺寸的，
// 只放大收件人视口的话，回放外框还是默认的 1280×720，验不到「宽屏上把录像放大铺满」。
test.use(
  process.env.VIBETERM_E2E_REPLAY_WIDE_VIEWER === '1'
    ? { deviceScaleFactor: 2, viewport: { width: 2400, height: 900 } }
    : {}
);

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
    sendPreShareLines(sessionName);
    await expect
      .poll(() => readTerminalBuffer(page), { timeout: 20_000 })
      .toContain(CHECKPOINT_LINES[1]);
    await clickConsoleMoreItem(page, 'share-open-button');
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

    // 录制中途由 tmux 侧改窗口尺寸（不经任何浏览器客户端）：日志必须出现与真实 pane 尺寸一致的 resize。
    await assertRecordsTmuxResize(page, share.id, sessionName);

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

    // 开窗那一刻的内容表面矩形：终端只开一台、尺寸一次定死，稳定之后不该再跳。
    const openedLayout = await readReplayLayout(page);

    // 快照正文是 gateway 用裸 LF 拼的多行文本：不补 CR 的话第二行会阶梯式缩进。
    if (
      !process.env.VIBETERM_E2E_REPLAY_LOG_FILE &&
      process.env.VIBETERM_E2E_REPLAY_CLAUDE !== '1' &&
      process.env.VIBETERM_E2E_REPLAY_TUI !== '1'
    ) {
      await expect
        .poll(() => countCheckpointLinesAtColumnZero(page), { timeout: 20_000 })
        .toBe(CHECKPOINT_LINES.length);
    }
    await page.screenshot({ path: `${SCREENSHOT_DIR}/replay-opened.png` });

    await playReplayToEnd(page);
    if (
      process.env.VIBETERM_E2E_REPLAY_CLAUDE === '1' ||
      process.env.VIBETERM_E2E_REPLAY_LOG_FILE
    ) {
      await page.waitForTimeout(1_500);
      expectNoScreenJump(openedLayout, await readReplayLayout(page));
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/replay-claude.png` });
      return;
    }
    expectNoScreenJump(openedLayout, await readReplayLayout(page));
    await waitForReplayTerminalSettled(page);
    const markerLine = await waitForReplayMarker(page);
    expect(
      markerLine.index,
      `expected ${MARKER} at column 0, got ${JSON.stringify(markerLine)}`
    ).toBe(0);

    // 快照是按录制网格拼的（primary 屏还带着 history 与绝对光标位置），必须在那个网格下写入。
    // 写错了的话可见画面会被顶到 history 之后、光标落进 history，屏幕上就会出现
    // 「有内容 → 空行 → 又有内容」这种断层，最后一行也不再是提示符。
    const buffer = (await readReplayLines(page)).map((line) => line.trimEnd());
    const filled = buffer.flatMap((line, row) => (line.trim() === '' ? [] : [row]));
    expect(
      filled.length,
      `replay buffer is empty: ${JSON.stringify(buffer.slice(0, 5))}`
    ).toBeGreaterThan(0);
    const first = filled[0];
    const last = filled[filled.length - 1];
    expect(
      last - first + 1,
      `blank rows inside the replayed screen: ${JSON.stringify(buffer.slice(first, last + 1))}`
    ).toBe(filled.length);
    expect(
      buffer[last],
      `last non-blank row should be the shell prompt: ${JSON.stringify(buffer.slice(-3))}`
    ).toContain('$');

    const layout = await readReplayLayout(page);
    expect(layout.panScrollLeft, `pan viewport scrollLeft=${layout.panScrollLeft}`).toBe(0);
    // 和普通终端一样：内容表面贴着外框左上角，没有衬底、没有居中留白。
    expect(
      Math.abs(layout.screenLeft - layout.rootLeft),
      `screen left=${layout.screenLeft} root left=${layout.rootLeft}`
    ).toBeLessThan(2);
    expect(
      Math.abs(layout.screenTop - layout.rootTop),
      `screen top=${layout.screenTop} root top=${layout.rootTop}`
    ).toBeLessThan(2);
    expect(
      Math.abs(layout.canvasLeft - layout.screenLeft),
      `canvas left=${layout.canvasLeft} screen left=${layout.screenLeft}`
    ).toBeLessThan(2);

    // 仿真网格 = 外框能放下的 ∪ 录像包络：铺满外框，最多差一个 cell 的取整余数；
    // 包络更大的那条边可以超出外框（由平移视口滚动），但绝不会留下空当。
    const box = `screen ${layout.screenWidth}×${layout.screenHeight} in frame ${layout.rootWidth}×${layout.rootHeight} cell ${layout.cellWidth}×${layout.cellHeight}`;
    expect(layout.cellWidth, box).toBeGreaterThan(0);
    expect(layout.screenWidth, box).toBeGreaterThanOrEqual(layout.rootWidth - layout.cellWidth - 1);
    expect(layout.screenHeight, box).toBeGreaterThanOrEqual(
      layout.rootHeight - layout.cellHeight - 1
    );

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
    await waitForReplayTerminalSettled(page);
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
