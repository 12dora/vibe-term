import { describe, expect, test } from 'bun:test';
import { BatchProgress, MAX_VISIBLE_ROWS } from './transfer-progress';

function single(direction: 'upload' | 'download', size = 100): BatchProgress {
  const progress = new BatchProgress(direction, [{ name: 'a.bin', size }]);
  progress.setStatus(0, 'running');
  return progress;
}

describe('条目进度', () => {
  test('上传权重 [1,0]：网络段满格只到 99%，成功后才是 100%', () => {
    const progress = single('upload');
    progress.weights(0, [1, 0]);
    progress.leg(0, 1, { pct: 100, bytes: 100, totalBytes: 100 });
    expect(progress.view().fraction).toBe(0.99);
    expect(progress.view().pct).toBe(99);

    progress.setStatus(0, 'done');
    expect(progress.view().pct).toBe(100);
    expect(progress.view().transferredBytes).toBe(100);
  });

  test('权重 [1,1]：两段等权，网络段满格而落盘未动时恰好一半', () => {
    const progress = single('upload');
    progress.leg(0, 1, { pct: 100, bytes: 100, totalBytes: 100 });
    expect(progress.view().fraction).toBe(0.5);
    progress.leg(0, 2, { pct: 50, bytes: 50, totalBytes: 100 });
    expect(progress.view().fraction).toBe(0.75);
  });

  test('下载：准备瞬间完成后权重 [0,1]，进度只看网络段', () => {
    const progress = single('download');
    progress.leg(0, 1, { pct: 100 });
    expect(progress.view().fraction).toBe(0.5);

    progress.weights(0, [0, 1]);
    expect(progress.view().fraction).toBe(0);
    progress.leg(0, 2, { pct: 25, bytes: 25, totalBytes: 100 });
    expect(progress.view().fraction).toBe(0.25);
  });

  test('有精确字节时以字节为准，没有才退回百分比', () => {
    const progress = single('upload');
    progress.weights(0, [1, 0]);
    progress.leg(0, 1, { pct: 0, bytes: 50, totalBytes: 100 });
    expect(progress.view().fraction).toBe(0.5);
    progress.leg(0, 1, { pct: 30 });
    expect(progress.view().fraction).toBe(0.3);
  });

  test('异常数值不会污染进度', () => {
    const progress = single('upload');
    progress.weights(0, [1, 0]);
    progress.leg(0, 1, { pct: Number.NaN, bytes: Number.NaN, totalBytes: -1 });
    expect(progress.view().fraction).toBe(0);
    progress.leg(0, 1, { pct: 250 });
    expect(progress.view().fraction).toBe(0.99);
  });

  test('排队中的条目为 0，失败 / 取消保留已到的进度', () => {
    const progress = new BatchProgress('upload', [{ name: 'a', size: 100 }]);
    expect(progress.view().fraction).toBe(0);
    progress.setStatus(0, 'running');
    progress.weights(0, [1, 0]);
    progress.leg(0, 1, { pct: 40 });
    progress.setStatus(0, 'failed');
    expect(progress.view().fraction).toBe(0.4);
  });
});

describe('批进度', () => {
  test('按字节加权：大文件决定总进度', () => {
    const progress = new BatchProgress('upload', [
      { name: 'big', size: 900 },
      { name: 'small', size: 100 },
    ]);
    progress.setStatus(0, 'done');
    progress.setStatus(1, 'running');
    progress.weights(1, [1, 0]);
    progress.leg(1, 1, { pct: 50, bytes: 50, totalBytes: 100 });
    const view = progress.view();
    expect(view.fraction).toBeCloseTo(0.95, 10);
    expect(view.transferredBytes).toBe(950);
    expect(view.totalBytes).toBe(1000);
    expect(view.itemsDone).toBe(1);
    expect(view.itemsTotal).toBe(2);
  });

  test('0 字节文件不占权重，全是 0 字节时按条目平均', () => {
    const mixed = new BatchProgress('upload', [
      { name: 'empty', size: 0 },
      { name: 'data', size: 100 },
    ]);
    mixed.setStatus(0, 'done');
    mixed.setStatus(1, 'running');
    mixed.weights(1, [1, 0]);
    mixed.leg(1, 1, { pct: 50 });
    expect(mixed.view().fraction).toBe(0.5);

    const empties = new BatchProgress('upload', [
      { name: 'e1', size: 0 },
      { name: 'e2', size: 0 },
    ]);
    empties.setStatus(0, 'done');
    expect(empties.view().pct).toBe(50);
    empties.setStatus(1, 'done');
    expect(empties.view().pct).toBe(100);
    expect(empties.view().itemsDone).toBe(2);
  });

  test('只要有条目没成功，总进度不会四舍五入成 100%', () => {
    const specs = Array.from({ length: 200 }, (_, i) => ({ name: `f${i}`, size: 10 }));
    const progress = new BatchProgress('upload', specs);
    for (let i = 0; i < 199; i++) progress.setStatus(i, 'done');
    progress.setStatus(199, 'running');
    progress.weights(199, [1, 0]);
    progress.leg(199, 1, { pct: 100 });
    expect(progress.view().pct).toBe(99);
  });

  test('速率输入：上传取 leg1、下载取 leg2 的真实字节，成功的条目按全量计', () => {
    const up = single('upload', 100);
    up.leg(0, 1, { pct: 0, bytes: 30, totalBytes: 100 });
    up.leg(0, 2, { pct: 0, bytes: 99, totalBytes: 100 });
    expect(up.view().networkBytes).toBe(30);

    const down = single('download', 100);
    down.leg(0, 1, { pct: 100, bytes: 100, totalBytes: 100 });
    down.leg(0, 2, { pct: 0, bytes: 20, totalBytes: 100 });
    expect(down.view().networkBytes).toBe(20);
    down.setStatus(0, 'done');
    expect(down.view().networkBytes).toBe(100);
  });

  test('列表只含未成功的条目，数量封顶', () => {
    const specs = Array.from({ length: MAX_VISIBLE_ROWS + 20 }, (_, i) => ({
      name: `f${i}`,
      size: 1,
    }));
    const progress = new BatchProgress('upload', specs);
    progress.setStatus(0, 'done');
    progress.setStatus(1, 'failed');
    const { rows } = progress.view();
    expect(rows).toHaveLength(MAX_VISIBLE_ROWS);
    expect(rows[0]).toMatchObject({ index: 1, name: 'f1', stage: 'failed' });
    expect(rows.some((row) => row.index === 0)).toBe(false);
    expect(progress.view().itemsFailed).toBe(1);
  });

  test('路径：任何条目落到中继就算中继', () => {
    const progress = single('upload');
    expect(progress.view().path).toBeNull();
    progress.setPath('direct');
    expect(progress.view().path).toBe('direct');
    progress.setPath('relay');
    progress.setPath('direct');
    expect(progress.view().path).toBe('relay');
  });
});

describe('阶段', () => {
  const stageOf = (progress: BatchProgress) => progress.view().rows[0]?.stage;

  test('上传：排队 → 准备 → 传输 → 写入', () => {
    const progress = new BatchProgress('upload', [{ name: 'a', size: 100 }]);
    expect(stageOf(progress)).toBe('queued');
    progress.setStatus(0, 'running');
    expect(stageOf(progress)).toBe('preparing');
    progress.leg(0, 1, { pct: 0 });
    expect(stageOf(progress)).toBe('transferring');
    progress.leg(0, 1, { pct: 100 });
    expect(stageOf(progress)).toBe('writing');
  });

  test('下载：准备结束（权重 leg1 为 0 或 leg1 满）后进入传输', () => {
    const viaWeights = single('download');
    expect(stageOf(viaWeights)).toBe('preparing');
    viaWeights.weights(0, [0, 1]);
    expect(stageOf(viaWeights)).toBe('transferring');

    const viaLeg = single('download');
    viaLeg.leg(0, 1, { pct: 40 });
    expect(stageOf(viaLeg)).toBe('preparing');
    viaLeg.leg(0, 1, { pct: 100 });
    expect(stageOf(viaLeg)).toBe('transferring');
  });

  test('终态原样映射', () => {
    const progress = single('upload');
    progress.setStatus(0, 'failed');
    expect(stageOf(progress)).toBe('failed');
    progress.setStatus(0, 'cancelled');
    expect(stageOf(progress)).toBe('cancelled');
  });
});
