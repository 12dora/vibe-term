import { describe, expect, test } from 'bun:test';
import { PANE_MODE_FLAGS_PRESENT } from '@tmex/shared';
import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
} from '@tmex/ws-client';
import { TerminalSurface, type TerminalSurfaceTarget } from './TerminalSurface';
import {
  type CanonicalSnapshotTarget,
  writeCanonicalSnapshot,
  writeLiveOutput,
} from './terminal-snapshot';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PREFIX = '\x1b[2J\x1b[H';
const PANE_EPOCH = new Uint8Array([1]);
const HISTORY_EPOCH = new Uint8Array([2]);

interface RecordingTarget extends CanonicalSnapshotTarget, TerminalSurfaceTarget {
  writes: string[];
  writeCallsPerFlush: number[];
  resets: number;
  repaints: number;
  sizes: Array<{ cols: number; rows: number }>;
  disposed: boolean;
}

function createTarget(): RecordingTarget {
  const target: RecordingTarget = {
    writes: [],
    writeCallsPerFlush: [],
    resets: 0,
    repaints: 0,
    sizes: [],
    disposed: false,
    liveOutputEndedWithCR: false,
    dispose: () => {
      target.disposed = true;
    },
    terminal: {
      reset: () => {
        target.resets += 1;
        target.writeCallsPerFlush.push(0);
      },
      resize: (cols, rows) => {
        target.sizes.push({ cols, rows });
      },
      write: (data) => {
        target.writes.push(typeof data === 'string' ? data : decoder.decode(data));
        const index = target.writeCallsPerFlush.length - 1;
        if (index >= 0) target.writeCallsPerFlush[index] += 1;
      },
      restoreModeSnapshot: () => {},
      forceFullRepaint: () => {
        target.repaints += 1;
      },
    },
  };
  return target;
}

interface Harness {
  surface: TerminalSurface<RecordingTarget>;
  target: RecordingTarget;
  recoveries: GatewayRebaseReason[];
  applied: Array<GatewayPaneScreenSnapshot | null>;
  stream(): string;
}

async function createHarness(options?: {
  maxHistoryPages?: number;
  maxHistoryBytes?: number;
}): Promise<Harness> {
  const target = createTarget();
  const recoveries: GatewayRebaseReason[] = [];
  const applied: Array<GatewayPaneScreenSnapshot | null> = [];
  const surface = new TerminalSurface<RecordingTarget>({
    createTarget: async () => target,
    writeSnapshot: writeCanonicalSnapshot,
    writeLive: writeLiveOutput,
    activate: () => {},
    onRecoveryRequired: (reason) => {
      recoveries.push(reason);
    },
    onSnapshotApplied: (_target, snapshot) => {
      applied.push(snapshot);
    },
    ...options,
  });
  await surface.initialize();
  return { surface, target, recoveries, applied, stream: () => target.writes.join('') };
}

function cursorOf(beforeLine: number): GatewayHistoryCursor {
  return {
    paneEpoch: PANE_EPOCH,
    historyEpoch: HISTORY_EPOCH,
    beforeLine,
  };
}

function snapshotOf(body: string, historyCursor: GatewayHistoryCursor | null) {
  const snapshot: GatewayPaneScreenSnapshot = {
    deviceId: 'device-1',
    paneId: '%1',
    paneEpoch: PANE_EPOCH,
    baseSeq: 0n,
    rows: 24,
    cols: 80,
    modes: PANE_MODE_FLAGS_PRESENT,
    data: encoder.encode(body),
    historyCursor,
  };
  return snapshot;
}

function pageOf(
  lineStart: number,
  lineEnd: number,
  body: string,
  overrides: Partial<GatewayPaneHistoryPage> = {}
): GatewayPaneHistoryPage {
  return {
    deviceId: 'device-1',
    paneId: '%1',
    paneEpoch: PANE_EPOCH,
    historyEpoch: HISTORY_EPOCH,
    lineStart,
    lineEnd,
    truncated: false,
    data: encoder.encode(body),
    nextCursor: lineStart > 0 ? cursorOf(lineStart) : null,
    ...overrides,
  };
}

const SNAPSHOT_BODY = `${PREFIX}current\n`;
// gateway 分页自新到旧回溯：lineStart 递减，每一页都必须落在已渲染内容之前。
const PAGE_NEWEST = pageOf(4, 6, 'l5\nl6\n');
const PAGE_MIDDLE = pageOf(2, 4, 'l3\nl4\n');
const PAGE_OLDEST = pageOf(0, 2, 'l1\nl2\n');

describe('TerminalSurface history paging', () => {
  test('replace writes the snapshot body verbatim and seeds the history cursor', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));

    expect(harness.stream()).toBe(`${PREFIX}current\r\n`);
    expect(harness.target.resets).toBe(1);
    expect(harness.target.sizes).toEqual([{ cols: 80, rows: 24 }]);
    expect(harness.surface.getNextHistoryCursor()).toEqual(cursorOf(6));
    expect(harness.applied).toEqual([null, expect.anything()]);
  });

  test('renders pages oldest-first as they arrive newest-first', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));

    harness.target.writes.length = 0;
    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);
    expect(harness.stream()).toBe(`${PREFIX}l5\r\nl6\r\ncurrent\r\n`);
    expect(harness.surface.getNextHistoryCursor()).toEqual(cursorOf(4));

    harness.target.writes.length = 0;
    expect(harness.surface.applyHistoryPage(PAGE_MIDDLE)).toBe(true);
    expect(harness.stream()).toBe(`${PREFIX}l3\r\nl4\r\nl5\r\nl6\r\ncurrent\r\n`);

    harness.target.writes.length = 0;
    expect(harness.surface.applyHistoryPage(PAGE_OLDEST)).toBe(true);
    expect(harness.stream()).toBe(`${PREFIX}l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\ncurrent\r\n`);
    expect(harness.surface.getNextHistoryCursor()).toBeNull();
  });

  test('每页到达都重建一次终端：reset / resize / repaint 各一次，CR 状态复位', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.target.liveOutputEndedWithCR = true;

    harness.surface.applyHistoryPage(PAGE_NEWEST);
    harness.surface.applyHistoryPage(PAGE_MIDDLE);

    expect(harness.target.resets).toBe(3);
    expect(harness.target.repaints).toBe(3);
    expect(harness.target.sizes).toHaveLength(3);
    expect(harness.target.liveOutputEndedWithCR).toBe(false);
    expect(harness.applied).toHaveLength(4);
  });

  test('history 落地后 live 输出继续追加在快照正文之后', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.surface.applyHistoryPage(PAGE_NEWEST);

    harness.target.writes.length = 0;
    harness.surface.write({ deviceId: 'device-1', paneId: '%1', data: encoder.encode('next\n') });
    expect(harness.stream()).toBe('next\r\n');
  });

  test('alternate-screen 模式位与快照尺寸在每次重建时保持一致', async () => {
    const harness = await createHarness();
    const snapshot = snapshotOf(SNAPSHOT_BODY, cursorOf(6));
    harness.surface.replace({ ...snapshot, cols: 100, rows: 30 });
    harness.surface.applyHistoryPage(PAGE_NEWEST);

    expect(harness.target.sizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 100, rows: 30 },
    ]);
  });

  test('无 history 时快照正文保留自带的清屏前缀', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, null));

    expect(harness.stream()).toBe(`${PREFIX}current\r\n`);
    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(false);
    expect(harness.recoveries).toEqual([]);
  });

  test('乱序 / 越界的页被拒绝并触发恢复', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.target.writes.length = 0;

    expect(harness.surface.applyHistoryPage(PAGE_MIDDLE)).toBe(false);
    expect(harness.recoveries).toEqual(['cache_evicted']);
    expect(harness.target.writes).toEqual([]);
    expect(harness.surface.getDiagnosticState().recoveryState).toBe('recovering');
  });

  test('页数上限触发时停止分页但不请求恢复', async () => {
    const harness = await createHarness({ maxHistoryPages: 1 });
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);

    expect(harness.surface.applyHistoryPage(PAGE_MIDDLE)).toBe(false);
    expect(harness.recoveries).toEqual([]);
    expect(harness.surface.getNextHistoryCursor()).toBeNull();
    expect(harness.surface.getDiagnosticState().historyPages).toBe(1);
  });

  test('字节上限触发时停止分页但不请求恢复', async () => {
    const harness = await createHarness({ maxHistoryBytes: 8 });
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);

    expect(harness.surface.applyHistoryPage(PAGE_MIDDLE)).toBe(false);
    expect(harness.recoveries).toEqual([]);
    expect(harness.surface.getNextHistoryCursor()).toBeNull();
    expect(harness.surface.getDiagnosticState().historyBytes).toBe(6);
  });

  test('replace 清空已累积的 history 并重新计数', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.surface.applyHistoryPage(PAGE_NEWEST);

    harness.target.writes.length = 0;
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    expect(harness.stream()).toBe(`${PREFIX}current\r\n`);
    expect(harness.surface.getDiagnosticState().historyPages).toBe(0);
    expect(harness.surface.getDiagnosticState().historyBytes).toBe(0);
  });

  test('dispose 之后不再写终端', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.surface.dispose();
    harness.target.writes.length = 0;

    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(false);
    expect(harness.target.writes).toEqual([]);
    expect(harness.target.disposed).toBe(true);
    expect(harness.surface.getDiagnosticState().recoveryState).toBe('disposed');
  });

  test('64 页累积后终端内容按行号升序排列', async () => {
    const harness = await createHarness();
    const pageCount = 64;
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(pageCount)));
    for (let index = pageCount; index > 0; index -= 1) {
      expect(harness.surface.applyHistoryPage(pageOf(index - 1, index, `l${index}\n`))).toBe(true);
    }

    const lines = Array.from({ length: pageCount }, (_, index) => `l${index + 1}`);
    expect(harness.stream().endsWith(`${lines.join('\r\n')}\r\ncurrent\r\n`)).toBe(true);
    expect(harness.surface.getDiagnosticState().historyPages).toBe(pageCount);
  });
});
