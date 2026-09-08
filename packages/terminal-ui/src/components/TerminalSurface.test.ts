import { describe, expect, test } from 'bun:test';
import { PANE_MODE_FLAGS_PRESENT } from '@vibeterm/shared';
import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
} from '@vibeterm/ws-client';
import {
  type SnapshotWriteOptions,
  TerminalSurface,
  type TerminalSurfaceTarget,
} from './TerminalSurface';
import {
  type CanonicalSnapshotTarget,
  restoreCanonicalViewport,
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
  scrolls: number[];
  /** 记录 write / scrollLines 的先后，用于断言还原发生在 live 回放之后 */
  calls: string[];
  /** 可写的视口模型：测试用它模拟「用户已经滚上去」 */
  active: { viewportY: number; baseY: number };
  setViewport(distanceFromBottom: number): void;
}

function createTarget(): RecordingTarget {
  const active = { viewportY: 0, baseY: 0 };
  const target: RecordingTarget = {
    active,
    setViewport: (distanceFromBottom) => {
      active.baseY = 1000;
      active.viewportY = 1000 - distanceFromBottom;
    },
    writes: [],
    writeCallsPerFlush: [],
    resets: 0,
    repaints: 0,
    sizes: [],
    disposed: false,
    scrolls: [],
    calls: [],
    liveOutputEndedWithCR: false,
    dispose: () => {
      target.disposed = true;
    },
    terminal: {
      buffer: { active },
      reset: () => {
        target.resets += 1;
        target.writeCallsPerFlush.push(0);
        target.calls.push('reset');
        // 真实终端 reset 之后视口回到底部
        active.viewportY = 0;
        active.baseY = 0;
      },
      resize: (cols, rows) => {
        target.sizes.push({ cols, rows });
      },
      write: (data) => {
        target.writes.push(typeof data === 'string' ? data : decoder.decode(data));
        const index = target.writeCallsPerFlush.length - 1;
        if (index >= 0) target.writeCallsPerFlush[index] += 1;
        target.calls.push('write');
      },
      restoreModeSnapshot: () => {},
      forceFullRepaint: () => {
        target.repaints += 1;
        target.calls.push('repaint');
      },
      scrollLines: (amount) => {
        target.scrolls.push(amount);
        target.calls.push('scrollLines');
        return true;
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
  // history 批处理窗口由测试显式驱动
  runScheduled(): void;
  scheduledCount(): number;
  // 视口还原的微任务同样由测试显式驱动
  runViewportRestores(): void;
}

async function createHarness(options?: {
  maxHistoryPages?: number;
  maxHistoryBytes?: number;
}): Promise<Harness> {
  const target = createTarget();
  const recoveries: GatewayRebaseReason[] = [];
  const applied: Array<GatewayPaneScreenSnapshot | null> = [];
  let pending: Array<() => void> = [];
  let restores: Array<() => void> = [];
  const surface = new TerminalSurface<RecordingTarget>({
    createTarget: async () => target,
    writeSnapshot: writeCanonicalSnapshot,
    restoreViewport: restoreCanonicalViewport,
    scheduleViewportRestore: (restore) => restores.push(restore),
    writeLive: writeLiveOutput,
    activate: () => {},
    onRecoveryRequired: (reason) => {
      recoveries.push(reason);
    },
    onSnapshotApplied: (_target, snapshot) => {
      applied.push(snapshot);
    },
    scheduleHistoryFlush: (flush) => pending.push(flush),
    ...options,
  });
  await surface.initialize();
  return {
    surface,
    target,
    recoveries,
    applied,
    stream: () => target.writes.join(''),
    runScheduled: () => {
      const callbacks = pending;
      pending = [];
      for (const callback of callbacks) callback();
    },
    scheduledCount: () => pending.length,
    runViewportRestores: () => {
      const callbacks = restores;
      restores = [];
      for (const callback of callbacks) callback();
    },
  };
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
/** 末页（nextCursor 为空）跳过批处理窗口立即落地，选项断言用它省掉手动驱动调度器 */
const PAGE_ONLY = pageOf(0, 6, 'l1\n');

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
    harness.runScheduled();
    expect(harness.stream()).toBe(`${PREFIX}l5\r\nl6\r\ncurrent\r\n`);
    expect(harness.surface.getNextHistoryCursor()).toEqual(cursorOf(4));

    harness.target.writes.length = 0;
    expect(harness.surface.applyHistoryPage(PAGE_MIDDLE)).toBe(true);
    harness.runScheduled();
    expect(harness.stream()).toBe(`${PREFIX}l3\r\nl4\r\nl5\r\nl6\r\ncurrent\r\n`);

    harness.target.writes.length = 0;
    // 末页（nextCursor 为空）不等窗口，直接落地
    expect(harness.surface.applyHistoryPage(PAGE_OLDEST)).toBe(true);
    expect(harness.stream()).toBe(`${PREFIX}l1\r\nl2\r\nl3\r\nl4\r\nl5\r\nl6\r\ncurrent\r\n`);
    expect(harness.surface.getNextHistoryCursor()).toBeNull();
  });

  test('一个窗口内到达的多页只重建一次终端：reset / resize / repaint 各一次，CR 状态复位', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.target.liveOutputEndedWithCR = true;

    harness.surface.applyHistoryPage(PAGE_NEWEST);
    harness.surface.applyHistoryPage(PAGE_MIDDLE);
    expect(harness.scheduledCount()).toBe(1);
    harness.runScheduled();

    expect(harness.target.resets).toBe(2);
    expect(harness.target.repaints).toBe(2);
    expect(harness.target.sizes).toHaveLength(2);
    expect(harness.target.liveOutputEndedWithCR).toBe(false);
    expect(harness.applied).toHaveLength(3);
  });

  test('22 页成串到达只触发一次重建', async () => {
    const pageCount = 22;
    const harness = await createHarness({ maxHistoryPages: pageCount });
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(pageCount)));
    harness.target.resets = 0;

    // 末页 lineStart 为 0（nextCursor 为空）会立即落地，这里只喂到倒数第二页
    for (let index = pageCount; index > 1; index -= 1) {
      expect(harness.surface.applyHistoryPage(pageOf(index - 1, index, `l${index}\n`))).toBe(true);
    }
    expect(harness.target.resets).toBe(0);

    harness.runScheduled();
    expect(harness.target.resets).toBe(1);
    expect(harness.surface.getDiagnosticState().historyPages).toBe(pageCount - 1);
  });

  test('live 输出到达时先落地攒着的 history，再追加字节', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.surface.applyHistoryPage(PAGE_NEWEST);

    harness.target.writes.length = 0;
    harness.surface.write({ deviceId: 'device-1', paneId: '%1', data: encoder.encode('next\n') });
    expect(harness.stream()).toBe(`${PREFIX}l5\r\nl6\r\ncurrent\r\nnext\r\n`);

    // 窗口到点时不再重建一次，live 字节不会被清掉
    harness.runScheduled();
    expect(harness.stream()).toBe(`${PREFIX}l5\r\nl6\r\ncurrent\r\nnext\r\n`);
  });

  test('alternate-screen 模式位与快照尺寸在每次重建时保持一致', async () => {
    const harness = await createHarness();
    const snapshot = snapshotOf(SNAPSHOT_BODY, cursorOf(6));
    harness.surface.replace({ ...snapshot, cols: 100, rows: 30 });
    harness.surface.applyHistoryPage(PAGE_NEWEST);
    harness.runScheduled();

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
    // 攒着的页随快照一起作废，窗口到点不再重建
    harness.runScheduled();
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

  test('重排选项：首屏不还原视口，history 分页还原', async () => {
    const target = createTarget();
    const seen: SnapshotWriteOptions[] = [];
    const surface = new TerminalSurface<RecordingTarget>({
      createTarget: async () => target,
      writeSnapshot: (writeTarget, snapshot, pages, options) => {
        seen.push(options);
        return writeCanonicalSnapshot(writeTarget, snapshot, pages, options);
      },
      restoreViewport: restoreCanonicalViewport,
      writeLive: writeLiveOutput,
      activate: () => {},
      onRecoveryRequired: () => {},
    });
    await surface.initialize();

    surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    expect(surface.applyHistoryPage(PAGE_ONLY)).toBe(true);

    expect(seen).toEqual([{ preserveViewport: false }, { preserveViewport: true }]);
  });

  test('16ms 窗口内到达的两页只重排一次（默认调度器）', async () => {
    const target = createTarget();
    const surface = new TerminalSurface<RecordingTarget>({
      createTarget: async () => target,
      writeSnapshot: writeCanonicalSnapshot,
      restoreViewport: restoreCanonicalViewport,
      writeLive: writeLiveOutput,
      activate: () => {},
      onRecoveryRequired: () => {},
    });
    await surface.initialize();
    surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    target.resets = 0;
    target.writes.length = 0;

    // 「到页即续」把第二页的请求在第一页落地时就发出去，两页因此落在同一个批处理窗口里
    expect(surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);
    expect(surface.applyHistoryPage(PAGE_MIDDLE)).toBe(true);
    expect(target.resets).toBe(0);

    await Bun.sleep(40);
    expect(target.resets).toBe(1);
    expect(target.writes).toEqual([`${PREFIX}l3\r\nl4\r\nl5\r\nl6\r\ncurrent\r\n`]);
  });

  test('视口还原发生在快照后 live 回放写完之后，且整次重排只绘一次', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    // 用户已经滚到离底部 100 行；期间 gateway 又攒了几行 live（重排后由注册表回放）
    harness.target.setViewport(100);
    harness.target.calls.length = 0;
    harness.target.repaints = 0;

    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);
    // 注册表的顺序：onHistoryPage → 回放 live 帧（后者经 write 触发攒着的重排）
    harness.surface.write({ deviceId: 'device-1', paneId: '%1', data: encoder.encode('live\n') });

    expect(harness.target.calls).toEqual(['reset', 'write', 'write']);
    expect(harness.target.scrolls).toEqual([]);

    harness.runViewportRestores();
    expect(harness.target.calls).toEqual(['reset', 'write', 'write', 'scrollLines', 'repaint']);
    expect(harness.target.scrolls).toEqual([-100]);
    expect(harness.target.repaints).toBe(1);
  });

  test('还原未落地前再重排一次，保留最先测到的锚点', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.target.setViewport(100);

    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);
    harness.runScheduled();
    // 第一次重排后终端停在底部；此时读到的任何位置都不是用户真正在看的那一行
    harness.target.setViewport(7);
    expect(harness.surface.applyHistoryPage(PAGE_MIDDLE)).toBe(true);
    harness.runScheduled();

    harness.target.scrolls.length = 0;
    harness.runViewportRestores();
    expect(harness.target.scrolls).toEqual([-100]);
  });

  test('还原前 dispose 则不再碰终端', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.target.setViewport(100);

    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);
    harness.runScheduled();
    harness.surface.dispose();

    harness.target.scrolls.length = 0;
    harness.runViewportRestores();
    expect(harness.target.scrolls).toEqual([]);
  });

  test('replace 作废攒着的锚点：换了一屏内容就该停在实时屏', async () => {
    const harness = await createHarness();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));
    harness.target.setViewport(100);

    expect(harness.surface.applyHistoryPage(PAGE_NEWEST)).toBe(true);
    harness.runScheduled();
    harness.surface.replace(snapshotOf(SNAPSHOT_BODY, cursorOf(6)));

    harness.target.scrolls.length = 0;
    harness.runViewportRestores();
    expect(harness.target.scrolls).toEqual([]);
  });

  test('64 页累积后终端内容按行号升序排列', async () => {
    // 页数上限由默认预算决定，这里只验证排序，显式放开上限
    const harness = await createHarness({ maxHistoryPages: 64 });
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
