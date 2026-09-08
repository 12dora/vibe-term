import { describe, expect, test } from 'bun:test';
import {
  HistoryPrefetchController,
  type HistoryPrefetchTimers,
  type HistoryPrefetchViewport,
  historyPrefetchBandRows,
  historyRequestDeadlineMs,
  withinHistoryPrefetchBand,
} from './paneHistoryRequest';

describe('historyRequestDeadlineMs', () => {
  test('keeps a 15s floor for fast or unknown links', () => {
    expect(historyRequestDeadlineMs(null)).toBe(15_000);
    expect(historyRequestDeadlineMs(undefined)).toBe(15_000);
    expect(historyRequestDeadlineMs(100)).toBe(15_000);
  });

  test('scales with latency up to a 60s ceiling', () => {
    expect(historyRequestDeadlineMs(3_000)).toBe(24_000);
    expect(historyRequestDeadlineMs(10_000)).toBe(60_000);
  });
});

describe('historyPrefetchBandRows', () => {
  test('预取带就是一屏高度，窄视口按 3 行兜底', () => {
    expect(historyPrefetchBandRows(40)).toBe(40);
    expect(historyPrefetchBandRows(2)).toBe(3);
    expect(historyPrefetchBandRows(0)).toBe(3);
    expect(historyPrefetchBandRows(Number.NaN)).toBe(3);
  });

  test('视口进入距顶一屏就算在带内', () => {
    expect(withinHistoryPrefetchBand({ viewportY: 24, rows: 24 })).toBe(true);
    expect(withinHistoryPrefetchBand({ viewportY: 25, rows: 24 })).toBe(false);
    expect(withinHistoryPrefetchBand({ viewportY: 0, rows: 24 })).toBe(true);
  });
});

interface Cursor {
  beforeLine: number;
}

interface PrefetchHarness {
  controller: HistoryPrefetchController<Cursor>;
  requests: Cursor[];
  viewport: HistoryPrefetchViewport | null;
  cursor: Cursor | null;
  visible: boolean;
  armedDeadlines: number[];
  fireDeadline(): void;
  pendingDeadlines(): number;
}

function createHarness(
  options: { viewportY?: number; rows?: number; visible?: boolean } = {}
): PrefetchHarness {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const fakeTimers: HistoryPrefetchTimers = {
    setTimeout: (handler, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, handler);
      harness.armedDeadlines.push(ms);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };

  const harness: PrefetchHarness = {
    controller: undefined as unknown as HistoryPrefetchController<Cursor>,
    requests: [],
    viewport: { viewportY: options.viewportY ?? 0, rows: options.rows ?? 24 },
    cursor: { beforeLine: 1000 },
    visible: options.visible ?? true,
    armedDeadlines: [],
    fireDeadline: () => {
      const entries = [...timers.entries()];
      timers.clear();
      for (const [, handler] of entries) handler();
    },
    pendingDeadlines: () => timers.size,
  };

  harness.controller = new HistoryPrefetchController<Cursor>({
    isVisible: () => harness.visible,
    getCursor: () => harness.cursor,
    getViewport: () => harness.viewport,
    request: (cursor) => {
      harness.requests.push(cursor);
    },
    deadlineMs: () => 20_000,
    timers: fakeTimers,
  });
  return harness;
}

describe('HistoryPrefetchController', () => {
  test('向上滚动进入距顶一屏的带内就请求，向下滚动不请求', () => {
    const harness = createHarness({ viewportY: 30, rows: 40 });
    harness.controller.handleWheel(10);
    expect(harness.requests).toHaveLength(0);

    harness.controller.handleWheel(-10);
    expect(harness.requests).toEqual([{ beforeLine: 1000 }]);
    expect(harness.armedDeadlines).toEqual([20_000]);
  });

  test('还没进带内（距顶超过一屏）时不预取', () => {
    const harness = createHarness({ viewportY: 41, rows: 40 });
    harness.controller.handleWheel(-10);
    expect(harness.requests).toHaveLength(0);
  });

  test('同一游标只发一次：在途期间的滚轮事件被吞掉', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);
    harness.controller.handleWheel(-1);
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(1);
  });

  test('页到达后仍在带内则立刻续发下一页，不等下一次滚轮', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);
    expect(harness.requests).toEqual([{ beforeLine: 1000 }]);

    harness.cursor = { beforeLine: 500 };
    harness.controller.handlePageArrived();

    expect(harness.requests).toEqual([{ beforeLine: 1000 }, { beforeLine: 500 }]);
    // 上一条请求的放弃计时器被换掉，不会留下悬空定时器
    expect(harness.pendingDeadlines()).toBe(1);
  });

  test('页到达后视口已被还原出带外则停止续发', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);

    harness.cursor = { beforeLine: 500 };
    harness.viewport = { viewportY: 512, rows: 24 };
    harness.controller.handlePageArrived();

    expect(harness.requests).toHaveLength(1);
    expect(harness.pendingDeadlines()).toBe(0);
  });

  test('分页到底（游标为空）后不再请求', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);
    harness.cursor = null;
    harness.controller.handlePageArrived();

    expect(harness.requests).toHaveLength(1);
  });

  test('放弃时限到点后放行下一次滚轮重试', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(1);

    harness.fireDeadline();
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(2);
  });

  test('终端未就绪（读不到视口）时不请求', () => {
    const harness = createHarness();
    harness.viewport = null;
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(0);
  });

  test('渲染挂起（保活池里的隐藏 pane）时不自动请求', () => {
    const harness = createHarness({ visible: false });
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(0);
  });

  test('隐藏 pane 收到页也不续拉：视口是冻结的，否则会一路拉到预算耗尽', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(1);

    harness.visible = false;
    for (let index = 0; index < 5; index += 1) {
      harness.cursor = { beforeLine: 500 - index };
      harness.controller.handlePageArrived();
    }
    expect(harness.requests).toHaveLength(1);
  });

  test('重新可见后恢复正常请求', () => {
    const harness = createHarness({ visible: false });
    harness.controller.handleWheel(-1);
    harness.visible = true;
    harness.controller.handleWheel(-1);

    expect(harness.requests).toEqual([{ beforeLine: 1000 }]);
  });

  test('dispose 清掉在途标记与放弃计时器', () => {
    const harness = createHarness();
    harness.controller.handleWheel(-1);
    harness.controller.dispose();

    expect(harness.pendingDeadlines()).toBe(0);
    harness.controller.handleWheel(-1);
    expect(harness.requests).toHaveLength(2);
  });
});
