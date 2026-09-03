// 渲染桥基准：updateRenderState + iterateRows + LineModel 构建的每帧耗时。
// 直接跑真实 ghostty-vt.wasm（与测试同一 loader），无 DOM 依赖。
// 运行：bun packages/ghostty-terminal/bench/render-bridge.bench.ts
import { getGhosttyBindings } from '../src/ghostty-wasm';
import {
  createRenderState,
  disposeRenderStateResources,
  iterateRows,
  readRenderSnapshotMeta,
  updateRenderState,
} from '../src/render-state';
import { buildLineModel } from '../src/selection-model';

const COLS = 120;
const ROWS = 40;
const WARMUP_FRAMES = 20;
const MEASURED_FRAMES = 200;

const SGR = ['', '\x1b[31m', '\x1b[1;32m', '\x1b[4;34m', '\x1b[7;33m', '\x1b[45;97m'];

function rowPayload(seed: number): string {
  const sgr = SGR[seed % SGR.length];
  const body = `${seed.toString(36).padStart(4, '0')} the quick brown fox jumps over the lazy dog `;
  return `${sgr}${body.repeat(3).slice(0, COLS - 1)}\x1b[0m`;
}

function cursorTo(row: number): string {
  return `\x1b[${row + 1};1H`;
}

type Scenario = {
  name: string;
  dirtyRows: number;
  mutate: (write: (data: string) => void, frame: number) => void;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'full update (40/40 rows rewritten)',
    dirtyRows: ROWS,
    mutate: (write, frame) => {
      for (let row = 0; row < ROWS; row += 1) {
        write(`${cursorTo(row)}\x1b[K${rowPayload(frame * ROWS + row)}`);
      }
    },
  },
  {
    name: 'single dirty row (1/40)',
    dirtyRows: 1,
    mutate: (write, frame) => {
      const row = frame % ROWS;
      write(`${cursorTo(row)}\x1b[K${rowPayload(frame)}`);
    },
  },
  {
    name: 'clean frames (0/40)',
    dirtyRows: 0,
    mutate: () => {},
  },
  {
    name: '20% dirty rows (8/40)',
    dirtyRows: Math.round(ROWS * 0.2),
    mutate: (write, frame) => {
      for (let index = 0; index < Math.round(ROWS * 0.2); index += 1) {
        const row = (frame * 3 + index * 5) % ROWS;
        write(`${cursorTo(row)}\x1b[K${rowPayload(frame * 8 + index)}`);
      }
    },
  },
];

function stats(samples: number[]): { mean: number; p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    mean: sum / samples.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
  };
}

function format(value: number): string {
  return value.toFixed(3).padStart(8);
}

async function runScenario(scenario: Scenario): Promise<void> {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(COLS, ROWS, 1000);
  const renderState = createRenderState(bindings);
  const write = (data: string) => bindings.writeVt(terminal, data);

  write(`\x1b[2J${cursorTo(0)}`);
  for (let row = 0; row < ROWS; row += 1) {
    write(`${cursorTo(row)}${rowPayload(row)}`);
  }

  const samples: number[] = [];
  const models = new WeakMap<object, unknown>();
  let sink = 0;
  let reportedDirtyRows = 0;
  let dirtyStates = '';

  for (let frame = 0; frame < WARMUP_FRAMES + MEASURED_FRAMES; frame += 1) {
    scenario.mutate(write, frame);

    const started = performance.now();
    updateRenderState(renderState, terminal);
    const rows = Array.from(iterateRows(renderState));
    const meta = readRenderSnapshotMeta(renderState);
    for (const row of rows) {
      // 与 coordinator 一致：只为内容变化的行重建 LineModel（旧实现每帧全建，
      // 因为内核把每一行都报成 dirty）。
      if (!models.has(row.cells)) {
        const model = buildLineModel(row.cells, row.wrap);
        models.set(row.cells, model);
        sink += model.contentCols;
      }
    }
    const elapsed = performance.now() - started;

    if (frame >= WARMUP_FRAMES) {
      samples.push(elapsed);
      reportedDirtyRows += rows.reduce((count, row) => count + (row.dirty ? 1 : 0), 0);
      dirtyStates += meta.dirty[0];
    }
    if (meta.rows !== ROWS) {
      throw new Error(`unexpected rows ${meta.rows}`);
    }
  }

  const { mean, p50, p95 } = stats(samples);
  const partialFrames = [...dirtyStates].filter((state) => state !== 'f').length;
  console.log(
    `${scenario.name.padEnd(34)} mean=${format(mean)}ms  p50=${format(p50)}ms  p95=${format(p95)}ms` +
      `  dirtyRows/frame=${(reportedDirtyRows / MEASURED_FRAMES).toFixed(1)}` +
      `  non-full frames=${partialFrames}/${MEASURED_FRAMES}  [${sink}]`
  );

  disposeRenderStateResources(renderState);
  bindings.freeTerminal(terminal);
}

async function runScrollScenario(name: string, amount: number): Promise<void> {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(COLS, ROWS, 2000);
  const renderState = createRenderState(bindings);
  const totalFrames = WARMUP_FRAMES + MEASURED_FRAMES;

  for (let line = 0; line < 1000; line += 1) {
    bindings.writeVt(terminal, `${rowPayload(line)}\r\n`);
  }
  if (amount > 0) {
    bindings.scrollViewportDelta(terminal, -(amount * totalFrames + 5));
  }

  updateRenderState(renderState, terminal);
  Array.from(iterateRows(renderState));
  readRenderSnapshotMeta(renderState);

  const samples: number[] = [];
  let previousOffset = bindings.readScrollbar(terminal).offset;
  let dirtyRows = 0;
  let fullFrames = 0;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    bindings.scrollViewportDelta(terminal, amount);
    const offset = bindings.readScrollbar(terminal).offset;
    const actualDelta = offset - previousOffset;
    if (actualDelta !== amount) {
      throw new Error(`${name} clamped unexpectedly: requested ${amount}, moved ${actualDelta}`);
    }

    const started = performance.now();
    updateRenderState(renderState, terminal);
    const rows = Array.from(iterateRows(renderState, actualDelta));
    const meta = readRenderSnapshotMeta(renderState);
    const elapsed = performance.now() - started;

    if (frame >= WARMUP_FRAMES) {
      samples.push(elapsed);
      dirtyRows += rows.reduce((count, row) => count + (row.dirty ? 1 : 0), 0);
      if (meta.dirty === 'full') {
        fullFrames += 1;
      }
    }
    previousOffset = offset;
  }

  const { mean, p50, p95 } = stats(samples);
  console.log(
    `${name.padEnd(34)} mean=${format(mean)}ms  p50=${format(p50)}ms  p95=${format(p95)}ms` +
      `  dirtyRows/frame=${(dirtyRows / MEASURED_FRAMES).toFixed(1)}` +
      `  full=${fullFrames}/${MEASURED_FRAMES}`
  );

  disposeRenderStateResources(renderState);
  bindings.freeTerminal(terminal);
}

// 单次 wasm 边界调用的成本：用于判断「打包行 ABI」是否值得。
async function measureWasmCallCost(): Promise<void> {
  const bindings = await getGhosttyBindings();
  const exports = bindings.exports;
  const terminal = bindings.createTerminal(COLS, ROWS, 1000);
  const renderState = createRenderState(bindings);
  bindings.writeVt(terminal, `${cursorTo(0)}${rowPayload(1)}`);
  updateRenderState(renderState, terminal);

  const iterator = bindings.createRenderStateRowIterator();
  const cells = bindings.createRenderStateRowCells();
  bindings.bindRenderStateRowIterator(renderState.renderStateHandle, iterator);
  bindings.nextRenderStateRowIterator(iterator);
  bindings.bindRenderStateRowCells(iterator, cells);
  bindings.nextRenderStateRowCell(cells);

  const out = bindings.allocBytes(64);
  const keys = bindings.allocBytes(32);
  const values = bindings.allocBytes(32);
  const written = bindings.allocBytes(8);
  const view = bindings.view();
  for (let index = 0; index < 3; index += 1) {
    view.setUint32(keys + index * 4, [1, 3, 2][index], true);
    view.setUint32(values + index * 4, out + index * 8, true);
  }
  view.setUint32(out + 16, 72, true);

  const iterations = 400_000;
  let sink = 0;

  let started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    exports.ghostty_render_state_row_cells_get(cells, 1, out);
  }
  const singleNs = ((performance.now() - started) * 1e6) / iterations;

  started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    exports.ghostty_render_state_row_cells_get_multi(cells, 3, keys, values, written);
  }
  const multiNs = ((performance.now() - started) * 1e6) / iterations;

  started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const ptr = bindings.allocBytes(8);
    bindings.freeBytes(ptr, 8);
  }
  const allocFreeNs = ((performance.now() - started) * 1e6) / iterations;

  started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    bindings.view();
  }
  const cachedViewNs = ((performance.now() - started) * 1e6) / iterations;

  const buffer = bindings.buffer();
  started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    sink += new DataView(buffer).byteLength;
  }
  const freshViewNs = ((performance.now() - started) * 1e6) / iterations;

  console.log(
    `wasm call cost: single_get=${singleNs.toFixed(1)}ns  get_multi(3)=${multiNs.toFixed(1)}ns` +
      `  alloc+free=${allocFreeNs.toFixed(1)}ns  new DataView=${freshViewNs.toFixed(1)}ns` +
      `  cached view()=${cachedViewNs.toFixed(1)}ns  [${sink}]`
  );

  bindings.freeBytes(out, 64);
  bindings.freeBytes(keys, 32);
  bindings.freeBytes(values, 32);
  bindings.freeBytes(written, 8);
  bindings.freeRenderStateRowCells(cells);
  bindings.freeRenderStateRowIterator(iterator);
  disposeRenderStateResources(renderState);
  bindings.freeTerminal(terminal);
}

console.log(`render bridge bench — ${COLS}x${ROWS}, ${MEASURED_FRAMES} measured frames\n`);
for (const scenario of SCENARIOS) {
  await runScenario(scenario);
}
await runScrollScenario('scroll +1 line/frame', 1);
await runScrollScenario('scroll +3 lines/frame', 3);
await runScrollScenario('scroll -1 line/frame', -1);
console.log('');
await measureWasmCallCost();
