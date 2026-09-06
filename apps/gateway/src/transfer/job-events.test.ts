// 事件订阅的有界缓冲与错误码归一化。

import { describe, expect, test } from 'bun:test';
import type { TransferJobEvent } from '@tmex/shared';
import { normalizeTransferError } from './errors';
import { jobEventsResponse } from './job-events';
import {
  createJob,
  resetTransferJobsForTests,
  setItemState,
  setJobItems,
  setJobState,
} from './job-registry';

function makeJob(jobId: string) {
  return createJob({
    jobId,
    uid: 'u1',
    fromNodeId: 'a'.repeat(32),
    toNodeId: 'b'.repeat(32),
    destRootId: 'root',
    destPath: '/tmp',
    path: 'relay',
    streams: 1,
  });
}

async function readEvents(res: Response): Promise<TransferJobEvent[]> {
  const text = await res.text();
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TransferJobEvent);
}

describe('job event subscription', () => {
  test('a consumer that never reads gets coalesced updates, not one event per byte', async () => {
    resetTransferJobsForTests();
    const job = makeJob('coalesce');
    setJobItems(job, [
      { relPath: 'a.bin', size: 10, state: 'pending', transferredBytes: 0 },
      { relPath: 'b.bin', size: 10, state: 'pending', transferredBytes: 0 },
    ]);
    const res = jobEventsResponse(job);
    for (let i = 0; i < 5000; i += 1) {
      setItemState(job, i % 2, { transferredBytes: i });
    }
    setJobState(job, 'done');
    const events = await readEvents(res);
    // 5000 次条目更新最多合并成两条（每个下标一条）
    expect(events.filter((e) => e.type === 'item').length).toBeLessThanOrEqual(4);
    expect(events[0]?.type).toBe('snapshot');
    expect(events.at(-1)?.type).toBe('end');
    expect(events.some((e) => e.type === 'state' && e.state === 'done')).toBe(true);
  });

  test('subscribing to a finished job yields snapshot then end', async () => {
    resetTransferJobsForTests();
    const job = makeJob('finished');
    setJobState(job, 'done');
    const events = await readEvents(jobEventsResponse(job));
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'end']);
  });

  test('an over-budget consumer is disconnected with a terminal end', async () => {
    resetTransferJobsForTests();
    const job = makeJob('overflow');
    const res = jobEventsResponse(job);
    // 不可合并的事件（state）灌满预算：订阅者被断开，但仍以 end 收尾
    for (let i = 0; i < 400; i += 1) setJobState(job, 'running');
    const events = await readEvents(res);
    expect(events.at(-1)?.type).toBe('end');
    expect(events.length).toBeLessThan(400);
  });
});

describe('transfer error normalizer', () => {
  test('forwarder constants become contract codes', () => {
    expect(normalizeTransferError('NODE_UNREACHABLE')).toBe('node_unreachable');
    expect(normalizeTransferError('NODE_LOGIN_REQUIRED')).toBe('peer_mismatch');
    expect(normalizeTransferError('dest_exists')).toBe('dest_exists');
    expect(normalizeTransferError('totally unknown')).toBe('unknown');
    expect(normalizeTransferError(undefined, 'node_unreachable')).toBe('node_unreachable');
  });
});
