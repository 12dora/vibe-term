import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCleanSession, getPaneSize, tmux } from './helpers/tmux';

// Task 6 诊断 spec（非回归测试）：在 worktree dev 实例（gateway 19663 + vite 19883）下，
// 启用 SGR mouse mode 的 TUI，分别在「单 pane」和「split-down 后分屏」两种场景下，
// 点击视觉 row 0/5/10 中部，捕获 TUI 实际收到的鼠标 row，对比 canvas/screen/pane 容器
// 的 rect.top，定位「分屏后 TUI 接收鼠标坐标差 1 行」的根因（候选 ①/②/③）。
//
// 输出：.sisyphus/evidence/task-6-bug1-diagnostic-report.md
//
// 严禁修复：本 spec 只测量、只产出报告。

const GATEWAY = 'http://localhost:19663';
const EVIDENCE_DIR = '.sisyphus/evidence';
const REPORT_PATH = `${EVIDENCE_DIR}/task-6-bug1-diagnostic-report.md`;
const NO_SOURCE_CHANGE_PATH = `${EVIDENCE_DIR}/task-6-no-source-change.txt`;
const MOUSE_LOG = '/tmp/issue45-mouse-events.log';
const SESSION = 'issue45-diag';
const VISUAL_ROWS = [0, 5, 10];

const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TUI_SCRIPT = resolve(WORKTREE_ROOT, 'scripts/issue45-mouse-tui.py');
const EVIDENCE_DIR_ABS = resolve(WORKTREE_ROOT, EVIDENCE_DIR);
const REPORT_PATH_ABS = resolve(WORKTREE_ROOT, REPORT_PATH);
const NO_SOURCE_CHANGE_PATH_ABS = resolve(WORKTREE_ROOT, NO_SOURCE_CHANGE_PATH);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
}
interface ScenarioMeasurements {
  screen: Rect | null;
  canvas: Rect | null;
  pane: Rect | null;
  titlebar: Rect | null;
  ancestorFlex: Rect | null;
}
interface ClickResult {
  visualRow: number;
  clickClientX: number;
  clickClientY: number;
  sgrButton: number | null;
  sgrCol: number | null;
  sgrRow: number | null;
  sgrAction: string | null;
  rawEventCount: number;
  rawBytesHex: string;
}
interface ScenarioResult {
  scenario: string;
  measurements: ScenarioMeasurements;
  cellWidth: number;
  cellHeight: number;
  paneCols: number;
  paneRows: number;
  clicks: ClickResult[];
}

function parseSGRLog(raw: string): {
  button: number | null;
  col: number | null;
  row: number | null;
  action: string | null;
  count: number;
} {
  const matches = raw.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g);
  let button: number | null = null;
  let col: number | null = null;
  let row: number | null = null;
  let action: string | null = null;
  let count = 0;
  for (const m of matches) {
    count += 1;
    if (m[4] === 'M') {
      button = Number.parseInt(m[1] ?? '0', 10);
      col = Number.parseInt(m[2] ?? '0', 10);
      row = Number.parseInt(m[3] ?? '0', 10);
      action = 'press';
    } else if (m[4] === 'm' && row === null) {
      button = Number.parseInt(m[1] ?? '0', 10);
      col = Number.parseInt(m[2] ?? '0', 10);
      row = Number.parseInt(m[3] ?? '0', 10);
      action = 'release';
    }
  }
  return { button, col, row, action, count };
}

async function measureDOM(
  page: import('@playwright/test').Page,
  paneId?: string
): Promise<ScenarioMeasurements> {
  return page.evaluate((pid: string | undefined) => {
    const rect = (el: Element | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height, bottom: r.bottom };
    };
    // 分屏时只测焦点 pane 的子树（避免 querySelector 取到上半非焦点 pane）
    const paneScope = pid
      ? document.querySelector(`[data-testid="split-pane"][data-pane-id="${pid}"]`) ??
        document.querySelector(`[data-testid="split-pane"][data-focused]`)
      : null;
    const root: Element | Document = paneScope ?? document;
    const screen = root.querySelector('.xterm-screen');
    const canvas = root.querySelector('canvas[data-layer], canvas');
    const pane = document.querySelector('[data-testid="split-pane"][data-focused]') ??
      document.querySelector('[data-testid="split-pane"]');
    const titlebar = pane?.querySelector('[data-testid="split-pane-titlebar"]') ?? null;
    const ancestorFlex =
      document.querySelector('[data-testid="device-page"] .relative.min-h-0.flex-1') ??
      document.querySelector('[data-testid="split-pane"] .relative.min-h-0.flex-1') ??
      null;
    return {
      screen: rect(screen),
      canvas: rect(canvas),
      pane: rect(pane),
      titlebar: rect(titlebar),
      ancestorFlex: rect(ancestorFlex),
    };
  }, paneId);
}

async function readGhosttyCellSize(
  page: import('@playwright/test').Page
): Promise<{ width: number; height: number } | null> {
  return page.evaluate(() => {
    const t =
      (window as unknown as { __tmexE2eTerminal?: { cellDimensions?: () => { width: number; height: number } } }).__tmexE2eTerminal ??
      (window as unknown as { __tmexE2eXterm?: { cellDimensions?: () => { width: number; height: number } } }).__tmexE2eXterm;
    if (!t?.cellDimensions) return null;
    try {
      return t.cellDimensions();
    } catch {
      return null;
    }
  });
}

async function ensureMouseModeEnabled(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const candidates = [
      (window as unknown as { __tmexE2eTerminal?: { write: (s: string) => void } }).__tmexE2eTerminal,
      (window as unknown as { __tmexE2eXterm?: { write: (s: string) => void } }).__tmexE2eXterm,
    ];
    for (const t of candidates) {
      t?.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
    }
  });
  await sleep(500);
}

async function clickRowAndCapture(
  page: import('@playwright/test').Page,
  visualRow: number,
  screenRect: Rect,
  cellWidth: number,
  cellHeight: number
): Promise<ClickResult> {
  writeFileSync(MOUSE_LOG, '');
  // 点击 row 中部：y = screenRect.top + (row + 0.5) * cellH
  // x 用 screenRect 中部（col = 40 即 80 列终端中间）
  const clickClientX = screenRect.left + screenRect.width / 2;
  const clickClientY = screenRect.top + (visualRow + 0.5) * cellHeight;
  await page.mouse.click(clickClientX, clickClientY, { delay: 60 });
  await sleep(400);
  let raw = '';
  try {
    raw = readFileSync(MOUSE_LOG, 'utf8');
  } catch {
    raw = '';
  }
  const parsed = parseSGRLog(raw);
  return {
    visualRow,
    clickClientX,
    clickClientY,
    sgrButton: parsed.button,
    sgrCol: parsed.col,
    sgrRow: parsed.row,
    sgrAction: parsed.action,
    rawEventCount: parsed.count,
    rawBytesHex: Buffer.from(raw, 'utf8').toString('hex').slice(0, 80),
  };
}

async function measureAndClickScenario(
  page: import('@playwright/test').Page,
  scenario: string,
  paneId: string
): Promise<ScenarioResult> {
  await page.waitForSelector('.xterm-screen', { timeout: 20000 });
  await sleep(2500);

  // tmux control mode 不会把 pane 内 TUI 输出的 mouse-enable 序列通过 %output 转发给
  // 外层 ghostty-wasm（tmux 把 \x1b[?1000h 当作自己的 mode set 消费）。因此前端实例
  // 的 mouse mode flag 默认保持 false，鼠标事件被本地选择吞掉。这里在前端直接注入
  // enable 序列——等效于 TUI 自己开启 mouse reporting，触发 getInputRoutingState()
  // .mouseReporting=true，从而让 emitMouseInput 走 SGR 编码外发路径。
  // 注：这只影响「前端 → TUI」的鼠标编码链路（即 bug 1 候选 ①/②/③ 的测量范围），
  // 不改变 mouse 坐标换算逻辑（pointerPositionFromClient / cellDimensions）。
  await ensureMouseModeEnabled(page);

  const measurements = await measureDOM(page, scenario === 'split-pane' ? paneId : undefined);
  if (!measurements.screen) {
    throw new Error(`[${scenario}] .xterm-screen not measured`);
  }
  const paneSize = getPaneSize(paneId);
  // 优先用 ghostty 内部 cellDimensions（与 pointerPositionFromClient / hitTest 用的
  // 是同一个 cell，消除「screen.height / pane.rows」的估算误差）
  const ghosttyCell = await readGhosttyCellSize(page);
  const cellHeight = ghosttyCell?.height ?? measurements.screen.height / paneSize.rows;
  const cellWidth = ghosttyCell?.width ?? measurements.screen.width / paneSize.cols;

  const clicks: ClickResult[] = [];
  for (const row of VISUAL_ROWS) {
    const r = await clickRowAndCapture(page, row, measurements.screen, cellWidth, cellHeight);
    clicks.push(r);
  }
  return {
    scenario,
    measurements,
    cellWidth,
    cellHeight,
    paneCols: paneSize.cols,
    paneRows: paneSize.rows,
    clicks,
  };
}

function buildReport(single: ScenarioResult, split: ScenarioResult): string {
  const fmt = (r: Rect | null): string =>
    r ? `{ top: ${r.top.toFixed(2)}, left: ${r.left.toFixed(2)}, w: ${r.width.toFixed(2)}, h: ${r.height.toFixed(2)} }` : 'null';

  const screenVsCanvasSingle = single.measurements.screen && single.measurements.canvas
    ? single.measurements.screen.top - single.measurements.canvas.top
    : null;
  const screenVsCanvasSplit = split.measurements.screen && split.measurements.canvas
    ? split.measurements.screen.top - split.measurements.canvas.top
    : null;

  const canvasTopDiff = single.measurements.canvas && split.measurements.canvas
    ? split.measurements.canvas.top - single.measurements.canvas.top
    : null;
  const screenTopDiff = single.measurements.screen && split.measurements.screen
    ? split.measurements.screen.top - single.measurements.screen.top
    : null;

  // 候选 ①：标题栏是否计入 screen rect（说明 selectSize 是否高估 rows）
  // 焦点 pane 的 screen.top 与 pane.top 的差值 = screen 上方占用的空间（含 titlebar）
  const screenToPaneOffsetSplit = split.measurements.screen && split.measurements.pane
    ? split.measurements.screen.top - split.measurements.pane.top
    : null;
  const titlebarHeightSplit = split.measurements.titlebar?.height ?? null;

  // SGR mouse 协议的 row/column 是 1-based（ghostty-wasm.ts:1180 floor(y/cellH)+1），
  // 因此 visual row 0 → SGR row 1 是正常基线，bug 1 的判据是「分屏 delta 相对单 pane
  // delta 的漂移」，而非 delta 本身。
  const SGR_BASELINE = 1;
  const singleRowDeltas = single.clicks.map((c) => (c.sgrRow ?? -1) - c.visualRow);
  const singleRowDeltaConsistent = singleRowDeltas.every((d) => d === singleRowDeltas[0]);
  const singleRowDeltaValue = singleRowDeltas[0] ?? null;
  const singleDeltaFromBaseline =
    singleRowDeltaValue !== null ? singleRowDeltaValue - SGR_BASELINE : null;
  const splitRowDeltas = split.clicks.map((c) => (c.sgrRow ?? -1) - c.visualRow);
  const splitRowDeltaConsistent = splitRowDeltas.every((d) => d === splitRowDeltas[0]);
  const splitRowDeltaValue = splitRowDeltas[0] ?? null;
  const splitDeltaFromBaseline =
    splitRowDeltaValue !== null ? splitRowDeltaValue - SGR_BASELINE : null;
  const singleToSplitDeltaShift =
    singleDeltaFromBaseline !== null && splitDeltaFromBaseline !== null
      ? splitDeltaFromBaseline - singleDeltaFromBaseline
      : null;

  const rowOffsetTable = [
    '| scenario | visual row | sgr row | delta (sgr - visual) | delta from SGR baseline | event count |',
    '|---|---|---|---|---|---|',
    ...single.clicks.map(
      (c) =>
        `| single-pane | ${c.visualRow} | ${c.sgrRow ?? '(none)'} | ${(c.sgrRow ?? -1) - c.visualRow} | ${(c.sgrRow ?? -1) - c.visualRow - SGR_BASELINE} | ${c.rawEventCount} |`
    ),
    ...split.clicks.map(
      (c) =>
        `| split-pane | ${c.visualRow} | ${c.sgrRow ?? '(none)'} | ${(c.sgrRow ?? -1) - c.visualRow} | ${(c.sgrRow ?? -1) - c.visualRow - SGR_BASELINE} | ${c.rawEventCount} |`
    ),
  ].join('\n');

  const canvasScreenEqualSingle = screenVsCanvasSingle !== null && Math.abs(screenVsCanvasSingle) < 0.5;
  const canvasScreenEqualSplit = screenVsCanvasSplit !== null && Math.abs(screenVsCanvasSplit) < 0.5;


  // 推断根因（基于 SGR 1-based 漂移判据）
  let verdict = '';
  let recommendation = '';
  const singleCorrect = singleDeltaFromBaseline === 0;
  const splitHasEvents = split.clicks.some((c) => c.rawEventCount > 0);

  if (!splitHasEvents) {
    verdict =
      '**分屏场景未捕获到 mouse event**：split-down 创建的新 pane 是默认 shell（无 mouse TUI），原 mouse TUI 所在 pane 已切回焦点并注入 enable，但事件未到达 TUI。可能 enable 注入的 ghostty 实例与原 pane 不一致，或前端点击落在新 pane 区域。需要进一步排查（保留这次单 pane 数据作为基线）。';
    recommendation =
      '**暂不推荐修复**——分屏场景数据缺失，需补充分屏 mouse mode 注入与点击目标对齐的测试增强。但单 pane delta 已确认 = SGR baseline（1-based），pointerPositionFromClient / cellDimensions 在单 pane 下工作正常。';
  } else if (singleCorrect && singleToSplitDeltaShift !== null && Math.abs(singleToSplitDeltaShift) >= 1) {
    verdict = `**bug 1 复现**：单 pane delta=${singleRowDeltaValue}（= SGR baseline），分屏 delta=${splitRowDeltaValue}，相对漂移 ${singleToSplitDeltaShift} 行。`;
    if (canvasScreenEqualSplit) {
      verdict += ' canvas.top == screen.top（候选 ③ inline strut 不成立）。';
    } else {
      verdict += ` canvas.top != screen.top（差 ${screenVsCanvasSplit?.toFixed(2)}px），候选 ③ inline strut 也可能贡献。`;
    }
    if (Math.abs(splitDeltaFromBaseline ?? 0) > 0.5) {
      verdict += ` cellHeight 在分屏前后 ${Math.abs(split.cellHeight - single.cellHeight) > 0.5 ? '变化显著' : '稳定'}（候选 ② ${Math.abs(split.cellHeight - single.cellHeight) > 0.5 ? '成立' : '不成立'}）。`;
    }
    recommendation =
      '**推荐方案 A（治本）**：pointerPositionFromClient 改用 mainCanvas 的 rect 作为鼠标基准（与渲染坐标严格一致），消除 screen inline strut 与 selectSize 顺序的耦合。同时建议**辅助方案 B**：让 DevicePage.getSelectSize 在分屏分支也扣 titleBarStackDepth * PANE_V_OVERHEAD_PX，与 SplitTerminalArea.reportWindowSize 对齐，从源头消除 rows 高估。';
  } else if (!singleCorrect) {
    verdict = `**单 pane delta 已偏离 SGR baseline**：delta=${singleRowDeltaValue}（期望 ${SGR_BASELINE}）。canvas.top == screen.top: ${canvasScreenEqualSingle}。`;
    recommendation =
      '若 canvas.top != screen.top → **候选 ③ inline strut**确认，**推荐方案 A**：pointerPositionFromClient 用 canvas rect。若 canvas.top == screen.top 但 delta 仍偏 → 检查 cellDimensions 与 screen.height 的比例（**候选 ②**）。';
  } else {
    verdict = `**未复现 bug 1**：单 pane delta=${singleRowDeltaValue}（= baseline），分屏 delta=${splitRowDeltaValue}，漂移 ${singleToSplitDeltaShift}（<1）。可能 bug 复现条件更严苛（如特定 cellSize 时序窗口、连续 split），或当前 dev 实例已不复发。`;
    recommendation =
      '保持现状；若后续仍报鼠标偏差，可在更复杂场景（连续 split、resize、跨窗 select）下重测，或加 force-full 重渲染对照。';
  }

  return `# Task 6: bug 1 鼠标坐标偏移诊断报告

> 在 worktree dev 实例（gateway 19663 + vite 19883，TMUX_SOCKET=tmex-e2e）下用真实 chromium + Playwright 实测。所有数据来自 \`page.evaluate(getBoundingClientRect)\` + TUI 内 SGR mouse 字节流解析。

## 测试环境

- 浏览器：Chromium (Playwright 内置 chromium-1208)
- 视口：1280 x 800
- TUI：\`scripts/issue45-mouse-tui.py\` 启用 SGR mouse mode（DEC 1000/1002/1006），输出 40 行 \`row N\` 锚点
- 视觉点击位置：row 0/5/10 中部（screen.left + width/2，screen.top + (row+0.5)*cellH）
- cellWidth/Height：优先用 ghostty 内部 cellDimensions()（与 pointerPositionFromClient / hitTest 同源）；不可用时回退 \`.xterm-screen\` rect / tmux pane cols/rows
- tmux socket：tmex-e2e（与生产 default socket 严格隔离）

## 单 pane 场景（scenario: single-pane）

- pane cols/rows：${single.paneCols} / ${single.paneRows}
- cellWidth × cellHeight：${single.cellWidth.toFixed(3)} × ${single.cellHeight.toFixed(3)} px
- .xterm-screen rect：${fmt(single.measurements.screen)}
- main canvas rect：${fmt(single.measurements.canvas)}
- [data-testid=split-pane] rect：${fmt(single.measurements.pane)}
- [data-testid=split-pane-titlebar] rect：${fmt(single.measurements.titlebar)}
- 祖先 flex-1 rect：${fmt(single.measurements.ancestorFlex)}
- canvas.top vs screen.top：${screenVsCanvasSingle?.toFixed(2) ?? 'n/a'} px

## 分屏场景（scenario: split-pane，split-down 触发后）

- 焦点 pane cols/rows：${split.paneCols} / ${split.paneRows}
- cellWidth × cellHeight：${split.cellWidth.toFixed(3)} × ${split.cellHeight.toFixed(3)} px
- .xterm-screen rect：${fmt(split.measurements.screen)}
- main canvas rect：${fmt(split.measurements.canvas)}
- [data-testid=split-pane] rect：${fmt(split.measurements.pane)}
- [data-testid=split-pane-titlebar] rect：${fmt(split.measurements.titlebar)}
- 祖先 flex-1 rect：${fmt(split.measurements.ancestorFlex)}
- canvas.top vs screen.top：${screenVsCanvasSplit?.toFixed(2) ?? 'n/a'} px
- screen.top 相对 pane.top 的偏移：${screenToPaneOffsetSplit?.toFixed(2) ?? 'n/a'} px（>0 说明 screen 上方有占用，含 titlebar）
- titlebar 高度：${titlebarHeightSplit?.toFixed(2) ?? 'n/a'} px

## 单 pane vs 分屏 rect 相对差异

- canvas.top 变化：${canvasTopDiff?.toFixed(2) ?? 'n/a'} px
- screen.top 变化：${screenTopDiff?.toFixed(2) ?? 'n/a'} px
- cellHeight 变化：${(split.cellHeight - single.cellHeight).toFixed(3)} px（**候选 ② cellDimensions 时序**：若 >0.5px 则分屏后 cell 高被重算）

## 鼠标 row 偏移对照表

${rowOffsetTable}

- 单 pane row delta：[${singleRowDeltas.join(', ')}]，一致：${singleRowDeltaConsistent}，定值：${singleRowDeltaValue}，相对 SGR baseline(${SGR_BASELINE}) 偏移：${singleDeltaFromBaseline}
- 分屏 row delta：[${splitRowDeltas.join(', ')}]，一致：${splitRowDeltaConsistent}，定值：${splitRowDeltaValue}，相对 SGR baseline(${SGR_BASELINE}) 偏移：${splitDeltaFromBaseline}
- 单 pane → 分屏 delta 漂移：${singleToSplitDeltaShift ?? 'n/a'}（**bug 1 复现指标**：绝对值 ≥1 即复现；SGR 协议 1-based 已扣除）

## 候选排除诊断

### 候选 ③（inline strut / .xterm-screen lineHeight=1.2）

- 判据：canvas.top != screen.top（>0.5px）
- 单 pane：canvas-screen top 差 ${screenVsCanvasSingle?.toFixed(2) ?? 'n/a'} px → **${canvasScreenEqualSingle ? '不成立' : '成立'}**
- 分屏：canvas-screen top 差 ${screenVsCanvasSplit?.toFixed(2) ?? 'n/a'} px → **${canvasScreenEqualSplit ? '不成立' : '成立'}**
- 备注：terminal.ts:1295-1310 的 pointerPositionFromClient 用 screenElement rect；若 canvas 与 screen 不重合，鼠标基准就错了

### 候选 ②（cellDimensions 时序）

- 判据：cellHeight 在分屏前后变化 >0.5px
- 实测：${(split.cellHeight - single.cellHeight).toFixed(3)} px → **${Math.abs(split.cellHeight - single.cellHeight) > 0.5 ? '成立' : '不成立'}**
- 备注：terminal.ts:1523-1553 updateCellDimensions 用 \`fontSize * lineHeight\` 公式，理论上稳定；若实测变化则字体加载或 dpr 改变

### 候选 ①（selectSize race）

- 判据：单 pane delta=SGR baseline(1)、分屏 delta≠单 pane delta（漂移 ≥1，1-based 已扣）
- 实测漂移：${singleToSplitDeltaShift ?? 'n/a'} → **${singleToSplitDeltaShift !== null && Math.abs(singleToSplitDeltaShift) >= 1 ? '成立' : '不成立'}**
- 备注：DevicePage.tsx:286-294 getSelectSize 不扣 titleBarStackDepth * PANE_V_OVERHEAD_PX，SplitTerminalArea.tsx:217 reportWindowSize 扣，两者容器 rect 同源但 rows 计算口径不一致；select 后短暂 rows 被高估，TUI 接收的 row 偏小
- 对照数据：分屏 screen.top 相对 pane.top 偏移 ${screenToPaneOffsetSplit?.toFixed(2) ?? 'n/a'} px，titlebar 高 ${titlebarHeightSplit?.toFixed(2) ?? 'n/a'} px

## 结论与推荐

### 根因判定

${verdict}

### 推荐修复方案

${recommendation}

### 方案备选（供 Task 10 评估）

- **A（治本）**：pointerPositionFromClient 改用 mainCanvas 的 getBoundingClientRect（terminal.ts:1299），与 canvas-renderer 的渲染坐标严格一致，对 inline strut / selectSize race 双重免疫
- **B（统一口径）**：DevicePage.getSelectSize 分屏分支扣 titleBarStackDepth * PANE_V_OVERHEAD_PX，与 SplitTerminalArea.reportWindowSize 对齐
- **C（防御）**：ghostty-terminal 创建 .xterm-screen 时显式设 \`lineHeight: '0'\`、\`display: 'block'\`，消除 inline strut；仅修候选 ③

## 限制

- 仅一次分屏触发；未测连续 split、resize、跨窗 select 等更复杂场景
- cellWidth/Height 来自 ghostty cellDimensions()（与 pointerPositionFromClient / hitTest 同源 cell）
- 未开 dev tools 录屏；如需复现动画，可加 \`video: 'on'\` 重跑
- 若 bug 1 仍在线上偶发，建议在受影响用户的真实浏览器（含扩展、字体、DPR）下用同一 spec 重测，对比 cellHeight / canvasScreen 偏移
`;
}

test('issue45 bug 1 mouse coordinate diagnostic', async ({ page }) => {
  test.setTimeout(180_000);

  ensureCleanSession(SESSION);
  tmux(
    `new-session -d -s ${SESSION} -x 120 -y 40 "python3 ${TUI_SCRIPT} ${MOUSE_LOG}"`
  );
  await sleep(2500);

  const paneContent = tmux(`capture-pane -p -t ${SESSION}`);
  console.log('[diag] TUI pane content (head):\n' + paneContent.split('\n').slice(0, 12).join('\n'));

  const paneId = tmux(`display-message -p -t ${SESSION} '#{pane_id}'`);
  console.log(`[diag] paneId=${paneId}`);

  const deviceName = `issue45-diag-${Date.now()}`;
  const createRes = await fetch(`${GATEWAY}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: deviceName,
      type: 'local',
      session: SESSION,
      authMode: 'auto',
    }),
  });
  expect(createRes.ok).toBeTruthy();
  const devJson = (await createRes.json()) as { device: { id: string } };
  const deviceId = devJson.device.id;
  console.log(`[diag] deviceId=${deviceId}`);

  let singleResult: ScenarioResult | null = null;
  let splitResult: ScenarioResult | null = null;

  try {
    await page.goto(`/devices/${deviceId}`);
    await page.waitForSelector('.xterm-screen', { timeout: 30000 });
    await sleep(3500);

    singleResult = await measureAndClickScenario(page, 'single-pane', paneId);
    console.log('[diag] single-pane done');

    await page.getByTestId('split-down-button').click();
    await page.waitForSelector('[data-testid="split-terminal-area"]', { timeout: 15000 });
    await expect(page.getByTestId('split-pane')).toHaveCount(2, { timeout: 15000 });
    await sleep(3500);

    // split-down 默认 split 出新 pane 跑默认 shell（无 mouse TUI）；本诊断关注的是
    // 「mouse TUI 所在 pane 在分屏前后坐标偏差」，因此切焦点回原 pane（paneId，即
    // mouse TUI 所在），让 enable 注入与点击都落在该 pane 上。
    const originPaneLocator = page.locator(
      `[data-testid="split-pane"][data-pane-id="${paneId}"]`
    );
    await originPaneLocator.click();
    await expect(
      page.locator(`[data-testid="split-pane"][data-focused][data-pane-id="${paneId}"]`)
    ).toBeVisible({ timeout: 8000 });
    await sleep(1000);

    splitResult = await measureAndClickScenario(page, 'split-pane', paneId);
    console.log('[diag] split-pane done');

    const report = buildReport(singleResult, splitResult);
    mkdirSync(EVIDENCE_DIR_ABS, { recursive: true });
    writeFileSync(REPORT_PATH_ABS, report);
    console.log(`[diag] report written to ${REPORT_PATH_ABS}`);

    writeFileSync(
      NO_SOURCE_CHANGE_PATH_ABS,
      [
        'Task 6 鼠标坐标诊断：未修改任何源代码。',
        `时间：${new Date().toISOString()}`,
        `commit：${execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()}`,
        `diff（应只含 spec + report + config + tui 脚本 + development.env.local）：`,
        '',
        execSync('git status --porcelain', { encoding: 'utf8', cwd: WORKTREE_ROOT }),
        '',
        'git diff --stat（对比 HEAD）：',
        execSync('git diff --stat HEAD', { encoding: 'utf8', cwd: WORKTREE_ROOT }),
      ].join('\n')
    );
    console.log(`[diag] no-source-change evidence written to ${NO_SOURCE_CHANGE_PATH_ABS}`);
  } finally {
    const delRes = await fetch(`${GATEWAY}/api/devices/${deviceId}`, { method: 'DELETE' });
    console.log(`[diag] device delete: ${delRes.status}`);
    ensureCleanSession(SESSION);
  }

  expect(singleResult).not.toBeNull();
  expect(splitResult).not.toBeNull();
  expect(readFileSync(REPORT_PATH_ABS, 'utf8').length).toBeGreaterThan(500);
});
