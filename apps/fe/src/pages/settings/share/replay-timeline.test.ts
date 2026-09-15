// 回放时间轴的纯计算：建索引、跳转计划、事件翻译、速度与时钟。

import { describe, expect, test } from 'bun:test';
import type { ShareLogEntry } from '@vibeterm/shared/share';
import {
  REPLAY_SPEEDS,
  base64ByteLength,
  buildReplayTimeline,
  clampReplayPreviewX,
  clampReplayTime,
  collectReplayOps,
  countEventsUntil,
  findCheckpointIndex,
  findReplayPane,
  formatReplayClock,
  formatReplayWallClock,
  nextReplaySpeed,
  planReplayMinorTicks,
  planReplaySeek,
  planReplayTicks,
  replayCrossesCalendarDay,
  replayGridAt,
  replayPaneEnvelope,
  replayScrubPositionToMs,
} from './replay-timeline';

const BASE = 1_700_000_000_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function entry(partial: Partial<ShareLogEntry> & { seq: number; at: number }): ShareLogEntry {
  return {
    kind: 'out',
    paneId: '%1',
    data: '',
    ...partial,
  } as ShareLogEntry;
}

/** `hi` 的 base64（2 字节）。 */
const HI = 'aGk=';

const LOG: ShareLogEntry[] = [
  entry({ seq: 1, at: BASE, kind: 'checkpoint', data: HI, cols: 80, rows: 24 }),
  entry({ seq: 2, at: BASE + 1000, data: HI }),
  entry({ seq: 3, at: BASE + 2000, kind: 'in', data: HI }),
  entry({ seq: 4, at: BASE + 3000, kind: 'resize', data: '', cols: 100, rows: 30 }),
  entry({ seq: 5, at: BASE + 4000, kind: 'checkpoint', data: HI, cols: 100, rows: 30 }),
  entry({ seq: 6, at: BASE + 5000, data: HI }),
];

describe('buildReplayTimeline', () => {
  test('空日志给空时间轴', () => {
    const timeline = buildReplayTimeline([]);
    expect(timeline).toEqual({ startAt: 0, durationMs: 0, panes: [] });
  });

  test('起点取最早时间，时长取跨度，事件按相对毫秒排布', () => {
    const timeline = buildReplayTimeline(LOG);
    expect(timeline.startAt).toBe(BASE);
    expect(timeline.durationMs).toBe(5000);
    expect(timeline.panes).toHaveLength(1);
    expect(timeline.panes[0].events.map((event) => event.t)).toEqual([
      0, 1000, 2000, 3000, 4000, 5000,
    ]);
  });

  test('记下 checkpoint 下标，只按输出计字节', () => {
    const [pane] = buildReplayTimeline(LOG).panes;
    expect(pane.checkpoints).toEqual([0, 4]);
    // out 两条各 2 字节；checkpoint 与 in 不计。
    expect(pane.bytes).toBe(4);
  });

  test('多 pane 按字节数降序，内容最多的排第一', () => {
    const timeline = buildReplayTimeline([
      entry({ seq: 1, at: BASE, paneId: '%1', data: HI }),
      entry({ seq: 2, at: BASE + 10, paneId: '%2', data: 'aGVsbG8gd29ybGQ=' }),
    ]);
    expect(timeline.panes.map((pane) => pane.paneId)).toEqual(['%2', '%1']);
    expect(findReplayPane(timeline, null)?.paneId).toBe('%2');
    expect(findReplayPane(timeline, '%1')?.paneId).toBe('%1');
    // 不认识的 pane 回落到第一个，而不是空屏
    expect(findReplayPane(timeline, '%9')?.paneId).toBe('%2');
  });

  test('resize 条目不带载荷', () => {
    const [pane] = buildReplayTimeline(LOG).panes;
    expect(pane.events[3].data).toBe('');
    expect(pane.events[3].cols).toBe(100);
  });

  test('带行列数的事件另记一份下标索引', () => {
    const [pane] = buildReplayTimeline(LOG).panes;
    expect(pane.grids).toEqual([
      { index: 0, cols: 80, rows: 24 },
      { index: 3, cols: 100, rows: 30 },
      { index: 4, cols: 100, rows: 30 },
    ]);
  });

  // countEventsUntil / replayGridAt 都在 t 上二分：时间戳一旦回退，二分给出的答案就是错的。
  test('时间戳回退的条目按同 pane 前一条对齐，t 序列非降', () => {
    const [pane] = buildReplayTimeline([
      entry({ seq: 1, at: BASE, data: HI }),
      entry({ seq: 2, at: BASE + 3000, data: HI }),
      entry({ seq: 3, at: BASE + 1000, data: HI }),
      entry({ seq: 4, at: BASE + 500, kind: 'resize', data: '', cols: 90, rows: 20 }),
      entry({ seq: 5, at: BASE + 4000, data: HI }),
    ]).panes;
    expect(pane.events.map((event) => event.t)).toEqual([0, 3000, 3000, 3000, 4000]);
    expect(countEventsUntil(pane, 3000)).toBe(4);
    expect(replayGridAt(pane, 3000)).toEqual({ cols: 90, rows: 20 });
    expect(replayGridAt(pane, 2999)).toBeNull();
  });

  // 各 pane 自己一条时间线：另一个 pane 的时间不该把这个 pane 的 t 顶起来。
  test('非降修正按 pane 各算各的', () => {
    const timeline = buildReplayTimeline([
      entry({ seq: 1, at: BASE, paneId: '%1', data: HI }),
      entry({ seq: 2, at: BASE + 9000, paneId: '%2', data: HI }),
      entry({ seq: 3, at: BASE + 1000, paneId: '%1', data: HI }),
    ]);
    const first = timeline.panes.find((pane) => pane.paneId === '%1');
    expect(first?.events.map((event) => event.t)).toEqual([0, 1000]);
  });
});

describe('base64ByteLength', () => {
  test('按填充算出解码后的字节数', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('aGk=')).toBe(2);
    expect(base64ByteLength('aGVsbG8=')).toBe(5);
    expect(base64ByteLength('aGVsbG8h')).toBe(6);
  });
});

describe('countEventsUntil / findCheckpointIndex', () => {
  const [pane] = buildReplayTimeline(LOG).panes;

  test('边界时间算作已播（含）', () => {
    expect(countEventsUntil(pane, -1)).toBe(0);
    expect(countEventsUntil(pane, 0)).toBe(1);
    expect(countEventsUntil(pane, 2500)).toBe(3);
    expect(countEventsUntil(pane, 99_999)).toBe(6);
  });

  test('取目标之前最后一个 checkpoint', () => {
    expect(findCheckpointIndex(pane, -1)).toBe(-1);
    expect(findCheckpointIndex(pane, 0)).toBe(0);
    expect(findCheckpointIndex(pane, 3999)).toBe(0);
    expect(findCheckpointIndex(pane, 4000)).toBe(4);
  });
});

describe('replayGridAt', () => {
  const [pane] = buildReplayTimeline(LOG).panes;

  test('取该时刻（含）之前最后一条带行列数的事件', () => {
    expect(replayGridAt(pane, 0)).toEqual({ cols: 80, rows: 24 });
    expect(replayGridAt(pane, 2999)).toEqual({ cols: 80, rows: 24 });
    expect(replayGridAt(pane, 3000)).toEqual({ cols: 100, rows: 30 });
    expect(replayGridAt(pane, 99_999)).toEqual({ cols: 100, rows: 30 });
  });

  test('第一条 checkpoint 之前没有网格', () => {
    expect(replayGridAt(pane, -1)).toBeNull();
  });

  test('整段没有 checkpoint / resize 时为 null', () => {
    const [plain] = buildReplayTimeline([
      entry({ seq: 1, at: BASE, data: HI }),
      entry({ seq: 2, at: BASE + 10, data: HI }),
    ]).panes;
    expect(replayGridAt(plain, 100)).toBeNull();
  });
});

describe('replayPaneEnvelope', () => {
  test('逐轴取整段录像出现过的最大值，中途缩小也不会让包络变小', () => {
    expect(replayPaneEnvelope(buildReplayTimeline(LOG).panes[0])).toEqual({ cols: 100, rows: 30 });
  });

  test('整份录像没有 checkpoint / resize 时为 null', () => {
    const [plain] = buildReplayTimeline([
      entry({ seq: 1, at: BASE, data: HI }),
      entry({ seq: 2, at: BASE + 10, data: HI }),
    ]).panes;
    expect(replayPaneEnvelope(plain)).toBeNull();
    expect(replayPaneEnvelope(buildReplayTimeline([]).panes[0])).toBeNull();
    expect(replayPaneEnvelope(null)).toBeNull();
  });
});

describe('planReplaySeek', () => {
  const [pane] = buildReplayTimeline(LOG).panes;

  test('往前走接着播，不重建终端', () => {
    expect(planReplaySeek(pane, 2000, 2)).toEqual({ reset: false, fromIndex: 2, toIndex: 3 });
  });

  test('往回跳从目标之前最后一个 checkpoint 重放', () => {
    expect(planReplaySeek(pane, 4500, 6)).toEqual({ reset: true, fromIndex: 4, toIndex: 5 });
    expect(planReplaySeek(pane, 1500, 5)).toEqual({ reset: true, fromIndex: 0, toIndex: 2 });
  });

  test('目标早于第一个 checkpoint 时从头重放', () => {
    const noCheckpoint = buildReplayTimeline([
      entry({ seq: 1, at: BASE, data: HI }),
      entry({ seq: 2, at: BASE + 1000, data: HI }),
    ]).panes[0];
    expect(planReplaySeek(noCheckpoint, 0, 2)).toEqual({
      reset: true,
      fromIndex: 0,
      toIndex: 1,
    });
  });

  test('游标传 Infinity 即强制重建（换 pane、终端刚就绪）', () => {
    expect(planReplaySeek(pane, 5000, Number.POSITIVE_INFINITY)).toEqual({
      reset: true,
      fromIndex: 4,
      toIndex: 6,
    });
  });
});

describe('collectReplayOps', () => {
  const [pane] = buildReplayTimeline(LOG).panes;

  // 快照单独成一条并带上录制网格：它的字节按那时的行列拼成（history + 绝对 CUP），
  // 必须在那个网格下写入，不能和普通输出合并。
  test('checkpoint 出一条带录制网格的快照操作', () => {
    expect(collectReplayOps(pane, 0, 1)).toEqual([
      { kind: 'resize', cols: 80, rows: 24 },
      { kind: 'checkpoint', data: HI, cols: 80, rows: 24 },
    ]);
  });

  test('快照之后的输出不会被并进快照那一条', () => {
    const ops = collectReplayOps(pane, 0, 2);
    expect(ops[1]).toEqual({ kind: 'checkpoint', data: HI, cols: 80, rows: 24 });
    expect(ops[2]?.kind).toBe('write');
  });

  test('连续输出合并成一条写入', () => {
    const merged = buildReplayTimeline([
      entry({ seq: 1, at: BASE, data: HI }),
      entry({ seq: 2, at: BASE + 1, data: HI }),
    ]).panes[0];
    expect(collectReplayOps(merged, 0, 2)).toEqual([{ kind: 'write', chunks: [HI, HI] }]);
  });

  test('输入单独成一条标记，不并进写入', () => {
    expect(collectReplayOps(pane, 1, 4)).toEqual([
      { kind: 'write', chunks: [HI] },
      { kind: 'input', t: 2000, data: HI },
      { kind: 'resize', cols: 100, rows: 30 },
    ]);
  });

  test('区间越界自动夹取', () => {
    expect(collectReplayOps(pane, -5, 0)).toEqual([]);
    expect(collectReplayOps(pane, 5, 99)).toEqual([{ kind: 'write', chunks: [HI] }]);
  });
});

describe('速度与时钟', () => {
  test('倍速按 1/2/4/8 循环', () => {
    expect(REPLAY_SPEEDS).toEqual([1, 2, 4, 8]);
    expect(nextReplaySpeed(1)).toBe(2);
    expect(nextReplaySpeed(4)).toBe(8);
    expect(nextReplaySpeed(8)).toBe(1);
  });

  test('时间夹在 [0, 时长] 内', () => {
    expect(clampReplayTime(-10, 5000)).toBe(0);
    expect(clampReplayTime(Number.NaN, 5000)).toBe(0);
    expect(clampReplayTime(9000, 5000)).toBe(5000);
    expect(clampReplayTime(1200, 5000)).toBe(1200);
  });

  test('不足一小时出 m:ss，超过出 h:mm:ss', () => {
    expect(formatReplayClock(0)).toBe('0:00');
    expect(formatReplayClock(65_400)).toBe('1:05');
    expect(formatReplayClock(3_725_000)).toBe('1:02:05');
  });
});

describe('formatReplayWallClock', () => {
  test('按本地时区拼 24 小时 HH:mm:ss，非法时间出空串', () => {
    const epoch = Date.UTC(2024, 5, 1, 6, 7, 8);
    const date = new Date(epoch);
    const expected = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
    expect(formatReplayWallClock(epoch, 'en_US')).toBe(expected);
    expect(formatReplayWallClock(epoch, 'zh_CN')).toBe(expected);
    expect(formatReplayWallClock(epoch, 'zh-CN')).toBe(expected);
    expect(formatReplayWallClock(epoch, undefined)).toBe(expected);
    expect(formatReplayWallClock(Number.NaN, 'en_US')).toBe('');
  });

  test('与 Intl 同一时区的 hour/minute/second 一致', () => {
    const epoch = Date.UTC(2023, 11, 31, 15, 4, 9);
    const formatted = formatReplayWallClock(epoch, 'ja_JP');
    const [hour, minute, second] = formatted.split(':').map(Number);
    const date = new Date(epoch);
    expect(hour).toBe(date.getHours());
    expect(minute).toBe(date.getMinutes());
    expect(second).toBe(date.getSeconds());
  });
});

describe('planReplayTicks', () => {
  test('空时长只在 0 打一格', () => {
    expect(planReplayTicks(0)).toEqual({ stepMs: 1_000, ticks: [0] });
    expect(planReplayTicks(-10)).toEqual({ stepMs: 1_000, ticks: [0] });
  });

  test('从 1s/5s/10s/30s/1min/5min/15min/1h 里挑 ~4–12 个主刻度', () => {
    expect(planReplayTicks(5_000)).toEqual({
      stepMs: 1_000,
      ticks: [0, 1_000, 2_000, 3_000, 4_000, 5_000],
    });
    expect(planReplayTicks(10_000).ticks).toHaveLength(11);
    expect(planReplayTicks(60_000)).toEqual({
      stepMs: 10_000,
      ticks: [0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000],
    });
    expect(planReplayTicks(300_000).stepMs).toBe(30_000);
    expect(planReplayTicks(3_600_000).stepMs).toBe(900_000);
    expect(planReplayTicks(3_600_000).ticks).toHaveLength(5);
  });

  test('窄轨道把刻度上限压到约 4', () => {
    const planned = planReplayTicks(60_000, 80);
    expect(planned.stepMs).toBe(30_000);
    expect(planned.ticks.length).toBeLessThanOrEqual(4);
  });

  test('26 小时录像按 6 小时档，不会按小时铺满', () => {
    const duration = 26 * HOUR_MS;
    const planned = planReplayTicks(duration);
    expect(planned.stepMs).toBe(6 * HOUR_MS);
    expect(planned.ticks).toEqual([0, 6, 12, 18, 24].map((hours) => hours * HOUR_MS));
    expect(planned.ticks.length).toBeLessThanOrEqual(24);
    const narrow = planReplayTicks(duration, 80);
    expect(narrow.stepMs).toBe(12 * HOUR_MS);
    expect(narrow.ticks.length).toBeLessThanOrEqual(4);
    expect(narrow.ticks.length).toBeLessThanOrEqual(24);
  });

  test('30 天录像主刻度硬上限 24，档位用尽时按整小时兜底', () => {
    const duration = 30 * DAY_MS;
    const planned = planReplayTicks(duration);
    expect(planned.stepMs).toBe(7 * DAY_MS);
    expect(planned.ticks.length).toBeLessThanOrEqual(24);
    const narrow = planReplayTicks(duration, 80);
    expect(narrow.stepMs % HOUR_MS).toBe(0);
    expect(narrow.stepMs).toBeGreaterThanOrEqual(7 * DAY_MS);
    expect(narrow.ticks.length).toBeLessThanOrEqual(24);
  });
});

describe('planReplayMinorTicks', () => {
  test('1 秒档不画次刻度，5 秒档在主刻度之间补', () => {
    expect(planReplayMinorTicks(5_000, 1_000)).toEqual([]);
    expect(planReplayMinorTicks(10_000, 5_000)).toEqual([
      1_000, 2_000, 3_000, 4_000, 6_000, 7_000, 8_000, 9_000,
    ]);
  });

  test('超过 60 个次刻度时整组不画', () => {
    const month = 30 * DAY_MS;
    expect(planReplayMinorTicks(month, HOUR_MS)).toEqual([]);
    expect(planReplayMinorTicks(month, 7 * DAY_MS).length).toBeLessThanOrEqual(60);
  });
});

describe('replayScrubPositionToMs', () => {
  const rect = { left: 100, width: 200 };

  test('按轨道比例映射并夹到 [0, duration]', () => {
    expect(replayScrubPositionToMs(100, rect, 5_000)).toBe(0);
    expect(replayScrubPositionToMs(200, rect, 5_000)).toBe(2_500);
    expect(replayScrubPositionToMs(300, rect, 5_000)).toBe(5_000);
    expect(replayScrubPositionToMs(50, rect, 5_000)).toBe(0);
    expect(replayScrubPositionToMs(400, rect, 5_000)).toBe(5_000);
  });

  test('宽度为 0 时回到起点', () => {
    expect(replayScrubPositionToMs(150, { left: 100, width: 0 }, 5_000)).toBe(0);
  });
});

describe('clampReplayPreviewX / replayCrossesCalendarDay', () => {
  test('预览标签中心夹在轨道内', () => {
    expect(clampReplayPreviewX(0, 200, 80)).toBe(40);
    expect(clampReplayPreviewX(1, 200, 80)).toBe(160);
    expect(clampReplayPreviewX(0.5, 200, 80)).toBe(100);
    expect(clampReplayPreviewX(0.5, 0, 80)).toBe(0);
    expect(clampReplayPreviewX(0.2, 60, 80)).toBe(30);
  });

  test('起止是否跨本地日历日', () => {
    const evening = new Date(2024, 0, 15, 23, 0, 0).getTime();
    expect(replayCrossesCalendarDay(evening, 30 * 60_000)).toBe(false);
    expect(replayCrossesCalendarDay(evening, 2 * 60 * 60_000)).toBe(true);
  });
});
