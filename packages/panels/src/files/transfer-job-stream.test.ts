import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import type { TransferJobSnapshot } from '@vibeterm/shared';
import { subscribeTransferJob } from './transfer-job-stream';
import {
  TRANSFER_JOB_GONE,
  getTransferJobView,
  resetTransferJobsForTest,
  transferJobKey,
  upsertTransferJobSnapshot,
} from './transfer-jobs-store';

const NODE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function snapshot(overrides: Partial<TransferJobSnapshot> = {}): TransferJobSnapshot {
  return {
    jobId: 'j1',
    state: 'running',
    fromNodeId: NODE_A,
    toNodeId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    destRootId: 'r1',
    destPath: '/data',
    expanding: false,
    items: [{ relPath: 'a.bin', size: 100, state: 'running', transferredBytes: 0 }],
    currentIndex: 0,
    progress: { transferredBytes: 0, totalBytes: 100, ratePerSec: 0, etaSec: null },
    streams: 1,
    path: 'direct',
    createdAt: 1000,
    updatedAt: 1000,
    finishedAt: null,
    ...overrides,
  };
}

type Reply = Response | (() => Promise<Response>);

class StubApiClient extends ApiClient {
  paths: string[] = [];

  constructor(private replies: Reply[]) {
    super('');
  }

  override fetch(path: string): Promise<Response> {
    this.paths.push(path);
    const next = this.replies.shift();
    if (!next) return Promise.reject(new Error('stream closed'));
    return typeof next === 'function' ? next() : Promise.resolve(next);
  }
}

function ndjson(events: unknown[]): Response {
  return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(''), { status: 200 });
}

function notFound(): Response {
  return new Response(JSON.stringify({ code: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 让订阅循环里挂起的 promise 都跑完。 */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const noSleep = () => Promise.resolve();

beforeEach(() => {
  resetTransferJobsForTest();
});

describe('subscribeTransferJob', () => {
  test('事件流写入 store，终态后不再重连', async () => {
    const client = new StubApiClient([
      ndjson([
        { type: 'snapshot', job: snapshot() },
        {
          type: 'progress',
          jobId: 'j1',
          currentIndex: 0,
          progress: { transferredBytes: 50, totalBytes: 100, ratePerSec: 25, etaSec: 2 },
          updatedAt: 1100,
        },
        { type: 'state', jobId: 'j1', state: 'done' },
        { type: 'end' },
      ]),
      json({
        job: snapshot({
          state: 'done',
          finishedAt: 2000,
          progress: { transferredBytes: 100, totalBytes: 100, ratePerSec: 0, etaSec: 0 },
        }),
      }),
    ]);

    subscribeTransferJob({ nodeId: NODE_A, jobId: 'j1', client, sleep: noSleep });
    await flush();

    const view = getTransferJobView(transferJobKey(NODE_A, 'j1'));
    expect(view?.state).toBe('done');
    expect(view?.pct).toBe(100);
    expect(client.paths).toEqual(['/api/transfer/jobs/j1/events', '/api/transfer/jobs/j1']);
  });

  test('断流后拉快照并重连，直到终态', async () => {
    const client = new StubApiClient([
      ndjson([{ type: 'snapshot', job: snapshot() }]),
      json({ job: snapshot({ state: 'running' }) }),
      ndjson([{ type: 'state', jobId: 'j1', state: 'failed', error: 'incomplete' }]),
      json({ job: snapshot({ state: 'failed', finishedAt: 3000 }) }),
    ]);

    subscribeTransferJob({ nodeId: NODE_A, jobId: 'j1', client, sleep: noSleep });
    await flush(30);

    expect(getTransferJobView(transferJobKey(NODE_A, 'j1'))?.state).toBe('failed');
    expect(client.paths).toEqual([
      '/api/transfer/jobs/j1/events',
      '/api/transfer/jobs/j1',
      '/api/transfer/jobs/j1/events',
      '/api/transfer/jobs/j1',
    ]);
  });

  test('快照请求失败且本地行不存在时收工', async () => {
    const client = new StubApiClient([]);
    subscribeTransferJob({ nodeId: NODE_A, jobId: 'j404', client, sleep: noSleep });
    await flush(20);
    expect(getTransferJobView(transferJobKey(NODE_A, 'j404'))).toBeUndefined();
    expect(client.paths).toEqual(['/api/transfer/jobs/j404/events', '/api/transfer/jobs/j404']);
  });

  test('事件流 404 时立刻收工，不再拉快照也不重连', async () => {
    upsertTransferJobSnapshot(NODE_A, snapshot());
    const client = new StubApiClient([notFound()]);

    subscribeTransferJob({ nodeId: NODE_A, jobId: 'j1', client, sleep: noSleep });
    await flush(20);

    const view = getTransferJobView(transferJobKey(NODE_A, 'j1'));
    expect(view?.state).toBe('failed');
    expect(view?.error).toBe(TRANSFER_JOB_GONE);
    expect(client.paths).toEqual(['/api/transfer/jobs/j1/events']);
  });

  test('快照 404 时把行落到终态并停止订阅', async () => {
    upsertTransferJobSnapshot(NODE_A, snapshot());
    const client = new StubApiClient([new Response('', { status: 200 }), notFound(), ndjson([])]);

    subscribeTransferJob({ nodeId: NODE_A, jobId: 'j1', client, sleep: noSleep });
    await flush(20);

    const view = getTransferJobView(transferJobKey(NODE_A, 'j1'));
    expect(view?.state).toBe('failed');
    expect(view?.error).toBe(TRANSFER_JOB_GONE);
    expect(client.paths).toEqual(['/api/transfer/jobs/j1/events', '/api/transfer/jobs/j1']);
  });

  test('同一任务重复订阅只开一条流', async () => {
    const client = new StubApiClient([
      ndjson([{ type: 'snapshot', job: snapshot({ state: 'done' }) }]),
      json({ job: snapshot({ state: 'done' }) }),
    ]);
    const stopA = subscribeTransferJob({ nodeId: NODE_A, jobId: 'j1', client, sleep: noSleep });
    const stopB = subscribeTransferJob({ nodeId: NODE_A, jobId: 'j1', client, sleep: noSleep });
    expect(stopB).toBe(stopA);
    await flush();
    expect(client.paths.filter((p) => p.endsWith('/events'))).toHaveLength(1);
  });
});
