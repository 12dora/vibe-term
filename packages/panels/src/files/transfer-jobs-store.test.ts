import { beforeEach, describe, expect, test } from 'bun:test';
import type { TransferJobSnapshot } from '@tmex/shared';
import {
  TRANSFER_JOB_GONE,
  applyTransferJobEvent,
  cancelTransferJobEntry,
  clearFinishedTransferJobs,
  combineLegPct,
  countFinishedItems,
  createRateEstimator,
  getTransferJobView,
  getTransferJobsSnapshot,
  isTerminalTransferState,
  reduceTransferEvent,
  resetTransferJobsForTest,
  settleMissingTransferJob,
  startLocalTransfer,
  subscribeTransferJobsStore,
  transferJobKey,
  transferPct,
  upsertTransferJobSnapshot,
  viewFromSnapshot,
} from './transfer-jobs-store';

const NODE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NODE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function snapshot(overrides: Partial<TransferJobSnapshot> = {}): TransferJobSnapshot {
  return {
    jobId: 'j1',
    state: 'running',
    fromNodeId: NODE_A,
    toNodeId: NODE_B,
    destRootId: 'r1',
    destPath: '/data',
    expanding: false,
    items: [
      { relPath: 'a.bin', size: 100, state: 'done', transferredBytes: 100 },
      { relPath: 'b.bin', size: 100, state: 'running', transferredBytes: 20 },
    ],
    currentIndex: 1,
    progress: { transferredBytes: 120, totalBytes: 200, ratePerSec: 60, etaSec: 1.3 },
    streams: 4,
    path: 'relay',
    createdAt: 1000,
    updatedAt: 1100,
    finishedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetTransferJobsForTest();
});

describe('纯函数', () => {
  test('key 由 nodeId 与 jobId 组合', () => {
    expect(transferJobKey(NODE_A, 'j1')).toBe(`${NODE_A}:j1`);
  });

  test('终态判定', () => {
    expect(isTerminalTransferState('done')).toBe(true);
    expect(isTerminalTransferState('failed')).toBe(true);
    expect(isTerminalTransferState('cancelled')).toBe(true);
    expect(isTerminalTransferState('running')).toBe(false);
    expect(isTerminalTransferState('queued')).toBe(false);
  });

  test('百分比在总量未知时为 0，并夹在 0–100', () => {
    expect(transferPct({ transferredBytes: 5, totalBytes: 0, ratePerSec: 0, etaSec: null })).toBe(
      0
    );
    expect(
      transferPct({ transferredBytes: 50, totalBytes: 200, ratePerSec: 0, etaSec: null })
    ).toBe(25);
    expect(
      transferPct({ transferredBytes: 500, totalBytes: 200, ratePerSec: 0, etaSec: null })
    ).toBe(100);
  });

  test('两段进度各占一半', () => {
    expect(combineLegPct(0, 0)).toBe(0);
    expect(combineLegPct(100, 0)).toBe(50);
    expect(combineLegPct(100, 100)).toBe(100);
    expect(combineLegPct(Number.NaN, 50)).toBe(25);
  });
});

describe('viewFromSnapshot', () => {
  test('取当前条目名、已完成条目数与进度百分比', () => {
    const view = viewFromSnapshot(NODE_A, snapshot());
    expect(view.key).toBe(`${NODE_A}:j1`);
    expect(view.kind).toBe('node');
    expect(view.title).toBe('b.bin');
    expect(view.itemsDone).toBe(1);
    expect(view.itemsTotal).toBe(2);
    expect(view.pct).toBe(60);
    expect(view.path).toBe('relay');
    expect(view.cancellable).toBe(true);
  });

  test('终态不可取消', () => {
    const view = viewFromSnapshot(NODE_A, snapshot({ state: 'done', finishedAt: 2000 }));
    expect(view.cancellable).toBe(false);
  });

  test('跳过的条目也计入已完成数', () => {
    const view = viewFromSnapshot(
      NODE_A,
      snapshot({
        items: [{ relPath: 'a.bin', size: 1, state: 'skipped', transferredBytes: 0 }],
        currentIndex: -1,
      })
    );
    expect(view.itemsDone).toBe(1);
    expect(view.title).toBe('a.bin');
  });
});

describe('reduceTransferEvent', () => {
  const base = viewFromSnapshot(NODE_A, snapshot());

  test('snapshot 事件整行替换', () => {
    const next = reduceTransferEvent(base, NODE_A, {
      type: 'snapshot',
      job: snapshot({ state: 'queued', currentIndex: 0 }),
    });
    expect(next.state).toBe('queued');
    expect(next.title).toBe('a.bin');
  });

  test('progress 事件更新字节与百分比', () => {
    const next = reduceTransferEvent(base, NODE_A, {
      type: 'progress',
      jobId: 'j1',
      currentIndex: 1,
      progress: { transferredBytes: 200, totalBytes: 200, ratePerSec: 10, etaSec: 0 },
      updatedAt: 1200,
    });
    expect(next.pct).toBe(100);
    expect(next.progress.ratePerSec).toBe(10);
    expect(next.updatedAt).toBe(1200);
  });

  test('item 事件推进当前条目与计数', () => {
    const next = reduceTransferEvent(base, NODE_A, {
      type: 'item',
      jobId: 'j1',
      index: 2,
      item: { relPath: 'c.bin', size: 10, state: 'running', transferredBytes: 0 },
    });
    expect(next.title).toBe('c.bin');
    expect(next.itemsTotal).toBe(3);
    expect(next.itemsDone).toBe(1);
  });

  test('item 事件按下标计数：失败的条目不算完成', () => {
    const job = viewFromSnapshot(
      NODE_A,
      snapshot({
        items: [
          { relPath: 'a.bin', size: 1, state: 'running', transferredBytes: 0 },
          { relPath: 'b.bin', size: 1, state: 'pending', transferredBytes: 0 },
          { relPath: 'c.bin', size: 1, state: 'pending', transferredBytes: 0 },
        ],
        currentIndex: 0,
      })
    );
    expect(job.itemsDone).toBe(0);

    const failed = reduceTransferEvent(job, NODE_A, {
      type: 'item',
      jobId: 'j1',
      index: 0,
      item: { relPath: 'a.bin', size: 1, state: 'failed', transferredBytes: 0 },
    });
    expect(failed.itemsDone).toBe(0);

    const done = reduceTransferEvent(failed, NODE_A, {
      type: 'item',
      jobId: 'j1',
      index: 1,
      item: { relPath: 'b.bin', size: 1, state: 'done', transferredBytes: 1 },
    });
    expect(done.itemsDone).toBe(1);

    const running = reduceTransferEvent(done, NODE_A, {
      type: 'item',
      jobId: 'j1',
      index: 2,
      item: { relPath: 'c.bin', size: 1, state: 'running', transferredBytes: 0 },
    });
    expect(running.itemsDone).toBe(1);
    expect(running.itemsTotal).toBe(3);
  });

  test('同一条目重复上报不重复计数，与快照口径一致', () => {
    const job = viewFromSnapshot(NODE_A, snapshot());
    const once = reduceTransferEvent(job, NODE_A, {
      type: 'item',
      jobId: 'j1',
      index: 1,
      item: { relPath: 'b.bin', size: 100, state: 'done', transferredBytes: 100 },
    });
    const twice = reduceTransferEvent(once, NODE_A, {
      type: 'item',
      jobId: 'j1',
      index: 1,
      item: { relPath: 'b.bin', size: 100, state: 'done', transferredBytes: 100 },
    });
    expect(twice.itemsDone).toBe(2);
    expect(twice.itemsDone).toBe(
      viewFromSnapshot(
        NODE_A,
        snapshot({
          items: [
            { relPath: 'a.bin', size: 100, state: 'done', transferredBytes: 100 },
            { relPath: 'b.bin', size: 100, state: 'done', transferredBytes: 100 },
          ],
        })
      ).itemsDone
    );
  });

  test('countFinishedItems 只数 done 与 skipped', () => {
    expect(countFinishedItems(['done', 'failed', 'skipped', undefined, 'running'])).toBe(2);
  });

  test('state 事件带错误码并关掉取消按钮', () => {
    const next = reduceTransferEvent(base, NODE_A, {
      type: 'state',
      jobId: 'j1',
      state: 'failed',
      error: 'quota_file_size',
      errorDetail: 'too big',
    });
    expect(next.state).toBe('failed');
    expect(next.error).toBe('quota_file_size');
    expect(next.errorDetail).toBe('too big');
    expect(next.cancellable).toBe(false);
    expect(next.finishedAt).not.toBeNull();
  });

  test('end 事件原样返回同一引用', () => {
    expect(reduceTransferEvent(base, NODE_A, { type: 'end' })).toBe(base);
  });
});

describe('store', () => {
  test('快照按创建时间倒序，且订阅者被通知', () => {
    let notified = 0;
    const unsubscribe = subscribeTransferJobsStore(() => {
      notified += 1;
    });
    upsertTransferJobSnapshot(NODE_A, snapshot({ jobId: 'j1', createdAt: 1000 }));
    upsertTransferJobSnapshot(NODE_A, snapshot({ jobId: 'j2', createdAt: 2000 }));
    expect(getTransferJobsSnapshot().map((view) => view.jobId)).toEqual(['j2', 'j1']);
    expect(notified).toBe(2);
    unsubscribe();
  });

  test('事件先于快照到达时只有 snapshot 会建行', () => {
    applyTransferJobEvent(NODE_A, 'j9', {
      type: 'state',
      jobId: 'j9',
      state: 'done',
    });
    expect(getTransferJobsSnapshot()).toHaveLength(0);

    applyTransferJobEvent(NODE_A, 'j9', { type: 'snapshot', job: snapshot({ jobId: 'j9' }) });
    expect(getTransferJobView(`${NODE_A}:j9`)?.jobId).toBe('j9');
  });

  test('清理已结束的行，保留运行中的', () => {
    upsertTransferJobSnapshot(NODE_A, snapshot({ jobId: 'j1', state: 'done' }));
    upsertTransferJobSnapshot(NODE_A, snapshot({ jobId: 'j2', state: 'running' }));
    clearFinishedTransferJobs();
    expect(getTransferJobsSnapshot().map((view) => view.jobId)).toEqual(['j2']);
  });
});

describe('settleMissingTransferJob', () => {
  test('任务已不存在时把行落到失败终态，可被清除已结束收走', () => {
    upsertTransferJobSnapshot(NODE_A, snapshot({ jobId: 'j1' }));
    settleMissingTransferJob(NODE_A, 'j1');
    const view = getTransferJobView(transferJobKey(NODE_A, 'j1'));
    expect(view?.state).toBe('failed');
    expect(view?.error).toBe(TRANSFER_JOB_GONE);
    expect(view?.cancellable).toBe(false);
    clearFinishedTransferJobs();
    expect(getTransferJobsSnapshot()).toHaveLength(0);
  });

  test('已终态或不存在的行不被改写', () => {
    upsertTransferJobSnapshot(NODE_A, snapshot({ jobId: 'j2', state: 'done' }));
    settleMissingTransferJob(NODE_A, 'j2');
    expect(getTransferJobView(transferJobKey(NODE_A, 'j2'))?.state).toBe('done');
    settleMissingTransferJob(NODE_A, 'nope');
    expect(getTransferJobView(transferJobKey(NODE_A, 'nope'))).toBeUndefined();
  });
});

describe('浏览器任务', () => {
  test('登记后可推进度、定路径并结束', () => {
    const handle = startLocalTransfer({
      id: 'u1',
      kind: 'upload',
      title: 'a.bin',
      nodeId: 'self',
      totalBytes: 1000,
    });

    const view = () => getTransferJobView(handle.key);
    expect(view()?.fromNodeId).toBe('browser');
    expect(view()?.toNodeId).toBe('self');
    expect(view()?.cancellable).toBe(false);

    handle.setPct(50);
    expect(view()?.pct).toBe(50);
    expect(view()?.progress.transferredBytes).toBe(500);

    handle.setPath('direct');
    expect(view()?.path).toBe('direct');

    handle.done();
    expect(view()?.state).toBe('done');
    expect(view()?.pct).toBe(100);
    expect(view()?.cancellable).toBe(false);
  });

  test('下载方向反过来，取消回调由列表触发', () => {
    let cancelled = 0;
    const handle = startLocalTransfer({
      id: 'd1',
      kind: 'download',
      title: 'b.bin',
      nodeId: NODE_B,
      onCancel: () => {
        cancelled += 1;
      },
    });
    expect(getTransferJobView(handle.key)?.fromNodeId).toBe(NODE_B);
    expect(getTransferJobView(handle.key)?.toNodeId).toBe('browser');
    expect(getTransferJobView(handle.key)?.cancellable).toBe(true);

    cancelTransferJobEntry(handle.key);
    expect(cancelled).toBe(1);

    handle.cancelled();
    expect(getTransferJobView(handle.key)?.state).toBe('cancelled');
  });

  test('总量未知时进度只有百分比', () => {
    const handle = startLocalTransfer({
      id: 'd2',
      kind: 'download',
      title: 'c.bin',
      nodeId: 'self',
    });
    handle.setPct(40);
    expect(getTransferJobView(handle.key)?.pct).toBe(40);
    expect(getTransferJobView(handle.key)?.progress.totalBytes).toBe(0);
    expect(getTransferJobView(handle.key)?.progress.etaSec).toBeNull();
  });
});

describe('createRateEstimator', () => {
  test('按滑窗算速率与 ETA', () => {
    const estimator = createRateEstimator();
    estimator.sample(0, 1000, 0);
    const p = estimator.sample(500, 1000, 1000);
    expect(p.ratePerSec).toBe(500);
    expect(p.etaSec).toBe(1);
  });

  test('尚无时间差时速率为 0、ETA 未知', () => {
    const estimator = createRateEstimator();
    const p = estimator.sample(100, 1000, 0);
    expect(p.ratePerSec).toBe(0);
    expect(p.etaSec).toBeNull();
  });
});
