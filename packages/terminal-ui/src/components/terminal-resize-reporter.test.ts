import { describe, expect, test } from 'bun:test';
import {
  type ResizeDimensionProposer,
  type TerminalResizeGate,
  TerminalResizeReporter,
  shouldAttemptResizeReport,
} from './terminal-resize-reporter';

interface FakeTerminal {
  cols: number;
  rows: number;
  element: unknown;
  _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
  resizes: Array<{ cols: number; rows: number }>;
  resize: (cols: number, rows: number) => void;
}

function createTerminal(cols = 80, rows = 24, cellWidth = 10, cellHeight = 20): FakeTerminal {
  const terminal: FakeTerminal = {
    cols,
    rows,
    element: { tag: 'div' },
    _core: {
      _renderService: { dimensions: { css: { cell: { width: cellWidth, height: cellHeight } } } },
    },
    resizes: [],
    resize: (nextCols, nextRows) => {
      terminal.resizes.push({ cols: nextCols, rows: nextRows });
      terminal.cols = nextCols;
      terminal.rows = nextRows;
    },
  };
  return terminal;
}

const GATE: TerminalResizeGate = {
  deviceId: 'device-1',
  paneId: 'pane-1',
  deviceConnected: true,
  isSelectionInvalid: false,
  sizingMode: 'report',
};

interface Harness {
  reporter: TerminalResizeReporter;
  terminal: FakeTerminal;
  events: Array<{ kind: string; cols: number; rows: number }>;
  setRect: (rect: { width: number; height: number } | null) => void;
  setNow: (value: number) => void;
}

function createHarness(options: { proposer?: ResizeDimensionProposer | null } = {}): Harness {
  const terminal = createTerminal();
  const events: Array<{ kind: string; cols: number; rows: number }> = [];
  const state = { rect: { width: 800, height: 480 } as { width: number; height: number } | null };
  const clock = { now: 1_000 };
  const proposer =
    options.proposer === undefined ? { proposeDimensions: () => null } : options.proposer;

  const reporter = new TerminalResizeReporter({
    getTerminal: () => terminal,
    getProposer: () => proposer,
    getContainerRect: () => state.rect,
    getHandlers: () => ({
      onResize: (cols, rows) => events.push({ kind: 'resize', cols, rows }),
      onSync: (cols, rows) => events.push({ kind: 'sync', cols, rows }),
      onResizeSettled: (cols, rows) => events.push({ kind: 'settled', cols, rows }),
    }),
    now: () => clock.now,
  });

  return {
    reporter,
    terminal,
    events,
    setRect: (rect) => {
      state.rect = rect;
    },
    setNow: (value) => {
      clock.now = value;
    },
  };
}

describe('shouldAttemptResizeReport', () => {
  test('follow 模式永不上报', () => {
    expect(
      shouldAttemptResizeReport({
        gate: { ...GATE, sizingMode: 'follow' },
        kind: 'sync',
        force: true,
        now: 0,
        suppressUntil: 0,
      })
    ).toBe(false);
  });

  test('缺少 deviceId / paneId / 连接时不上报', () => {
    const base = { kind: 'resize', force: false, now: 0, suppressUntil: 0 } as const;
    expect(shouldAttemptResizeReport({ ...base, gate: { ...GATE, deviceId: '' } })).toBe(false);
    expect(shouldAttemptResizeReport({ ...base, gate: { ...GATE, paneId: '' } })).toBe(false);
    expect(shouldAttemptResizeReport({ ...base, gate: { ...GATE, deviceConnected: false } })).toBe(
      false
    );
  });

  test('选择失效时仅放行 sync', () => {
    const gate = { ...GATE, isSelectionInvalid: true };
    expect(
      shouldAttemptResizeReport({ gate, kind: 'resize', force: false, now: 0, suppressUntil: 0 })
    ).toBe(false);
    expect(
      shouldAttemptResizeReport({ gate, kind: 'sync', force: false, now: 0, suppressUntil: 0 })
    ).toBe(true);
  });

  test('抑制窗口内非 force 请求被拒，force 请求放行', () => {
    expect(
      shouldAttemptResizeReport({
        gate: GATE,
        kind: 'resize',
        force: false,
        now: 500,
        suppressUntil: 900,
      })
    ).toBe(false);
    expect(
      shouldAttemptResizeReport({
        gate: GATE,
        kind: 'resize',
        force: true,
        now: 500,
        suppressUntil: 900,
      })
    ).toBe(true);
  });
});

describe('TerminalResizeReporter.measure', () => {
  test('容器隐藏（0×0）时返回 null', () => {
    const harness = createHarness();
    harness.setRect({ width: 0, height: 0 });
    expect(harness.reporter.measure()).toBeNull();
  });

  test('缺少 terminal / proposer / rect 时返回 null', () => {
    const noProposer = createHarness({ proposer: null });
    expect(noProposer.reporter.measure()).toBeNull();

    const noRect = createHarness();
    noRect.setRect(null);
    expect(noRect.reporter.measure()).toBeNull();
  });

  test('proposeDimensions 优先于 cell 回退计算列数', () => {
    const harness = createHarness({ proposer: { proposeDimensions: () => ({ cols: 42 }) } });
    expect(harness.reporter.measure()).toEqual({ cols: 42, rows: 24 });
  });

  test('proposeDimensions 抛错时按 cell 尺寸回退', () => {
    const harness = createHarness({
      proposer: {
        proposeDimensions: () => {
          throw new Error('not ready');
        },
      },
    });
    expect(harness.reporter.measure()).toEqual({ cols: 80, rows: 24 });
  });
});

describe('TerminalResizeReporter.report', () => {
  test('首次 resize 上报并记录 last/pending，同步触发 settled', () => {
    const harness = createHarness();
    harness.setNow(5_000);

    expect(harness.reporter.report({ kind: 'resize', gate: GATE })).toBe(true);
    expect(harness.events).toEqual([
      { kind: 'resize', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
    ]);
    expect(harness.reporter.lastReportedSize.current).toEqual({ cols: 80, rows: 24 });
    expect(harness.reporter.pendingLocalSize.current).toEqual({ cols: 80, rows: 24, at: 5_000 });
  });

  test('sync 走 onSync 通道', () => {
    const harness = createHarness();
    harness.reporter.report({ kind: 'sync', gate: GATE });
    expect(harness.events.map((event) => event.kind)).toEqual(['sync', 'settled']);
  });

  test('尺寸未变化的非 force 请求短路：仍对齐终端但不上报', () => {
    const harness = createHarness();
    harness.reporter.report({ kind: 'resize', gate: GATE });
    harness.events.length = 0;
    harness.terminal.resizes.length = 0;

    expect(harness.reporter.report({ kind: 'resize', gate: GATE })).toBe(true);
    expect(harness.events).toEqual([]);
    expect(harness.terminal.resizes).toEqual([]);
  });

  test('force 请求在尺寸未变化时仍然上报', () => {
    const harness = createHarness();
    harness.reporter.report({ kind: 'sync', gate: GATE });
    harness.events.length = 0;

    expect(harness.reporter.report({ kind: 'sync', force: true, gate: GATE })).toBe(true);
    expect(harness.events).toEqual([
      { kind: 'sync', cols: 80, rows: 24 },
      { kind: 'settled', cols: 80, rows: 24 },
    ]);
  });

  test('容器尺寸变化时对齐终端并上报新尺寸', () => {
    const harness = createHarness();
    harness.reporter.report({ kind: 'resize', gate: GATE });
    harness.terminal.resizes.length = 0;
    harness.events.length = 0;

    harness.setRect({ width: 400, height: 200 });
    expect(harness.reporter.report({ kind: 'resize', gate: GATE })).toBe(true);
    expect(harness.terminal.resizes).toEqual([{ cols: 40, rows: 10 }]);
    expect(harness.events).toEqual([
      { kind: 'resize', cols: 40, rows: 10 },
      { kind: 'settled', cols: 40, rows: 10 },
    ]);
  });

  test('容器隐藏时不上报且不污染 last/pending', () => {
    const harness = createHarness();
    harness.setRect({ width: 0, height: 0 });

    expect(harness.reporter.report({ kind: 'resize', gate: GATE })).toBe(false);
    expect(harness.events).toEqual([]);
    expect(harness.reporter.lastReportedSize.current).toBeNull();
    expect(harness.reporter.pendingLocalSize.current).toBeNull();
  });

  test('门禁拒绝时不测量也不上报', () => {
    const harness = createHarness();
    expect(
      harness.reporter.report({ kind: 'resize', gate: { ...GATE, sizingMode: 'follow' } })
    ).toBe(false);
    expect(harness.events).toEqual([]);
  });

  test('抑制窗口生效期间拒绝非 force 请求', () => {
    const harness = createHarness();
    harness.setNow(1_000);
    harness.reporter.suppressLocalResizeUntil.current = 2_000;

    expect(harness.reporter.report({ kind: 'resize', gate: GATE })).toBe(false);
    expect(harness.events).toEqual([]);
    expect(harness.reporter.report({ kind: 'resize', force: true, gate: GATE })).toBe(true);
  });
});
