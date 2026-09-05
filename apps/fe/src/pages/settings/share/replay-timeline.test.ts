// 回放时间轴的纯计算：建索引、跳转计划、事件翻译、速度与时钟。

import { describe, expect, test } from 'bun:test';
import type { ShareLogEntry } from '@tmex/shared/share';
import {
  REPLAY_SPEEDS,
  base64ByteLength,
  buildReplayTimeline,
  clampReplayTime,
  collectReplayOps,
  countEventsUntil,
  findCheckpointIndex,
  findReplayPane,
  formatReplayClock,
  nextReplaySpeed,
  planReplaySeek,
} from './replay-timeline';

const BASE = 1_700_000_000_000;

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

  test('checkpoint 先定尺寸再写屏', () => {
    expect(collectReplayOps(pane, 0, 1)).toEqual([
      { kind: 'resize', cols: 80, rows: 24 },
      { kind: 'write', chunks: [HI] },
    ]);
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
