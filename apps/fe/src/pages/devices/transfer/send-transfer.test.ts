// 发送一次传输的请求顺序与落库。`createNodeApiClient` 走 `globalThis.fetch`，这里整体替换掉。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@tmex/api-client';
import {
  getTransferJobsSnapshot,
  resetTransferJobsForTest,
  stopAllTransferSubscriptions,
} from '@tmex/panels/files/transfers';
import { sendTransfer, transferErrorKey, transferErrorKeyOf } from './send-transfer';

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body: unknown }> = [];
let replies: Response[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const JOB = {
  jobId: 'j1',
  state: 'running',
  fromNodeId: ENTRY,
  toNodeId: REMOTE,
  destRootId: 'r2',
  destPath: '/data',
  expanding: false,
  items: [{ relPath: 'a.bin', size: 10, state: 'running', transferredBytes: 0 }],
  currentIndex: 0,
  progress: { transferredBytes: 0, totalBytes: 10, ratePerSec: 0, etaSec: null },
  streams: 4,
  path: 'direct',
  createdAt: 1,
  updatedAt: 1,
  finishedAt: null,
};

beforeEach(() => {
  resetTransferJobsForTest();
  calls = [];
  replies = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = replies.shift();
    // 事件流：给一个空 NDJSON 体，订阅循环立刻收尾
    return Promise.resolve(next ?? new Response('', { status: 200 }));
  }) as typeof fetch;
});

afterEach(() => {
  stopAllTransferSubscriptions();
  resetTransferJobsForTest();
  globalThis.fetch = originalFetch;
});

describe('sendTransfer', () => {
  test('先在目标节点换 grant，再在源节点建任务，并把任务落进列表', async () => {
    replies = [
      json({ grantId: 'g1', token: 'tok', expiresAt: 9 }),
      json({ job: JOB }),
      new Response('', { status: 200 }),
      json({ job: { ...JOB, state: 'done' } }),
    ];

    const job = await sendTransfer({
      source: { nodeId: 'self', meshId: ENTRY, rootId: 'r1', path: '/src', paths: ['/src/a.bin'] },
      dest: { nodeId: REMOTE, meshId: REMOTE, rootId: 'r2', path: '/data' },
    });

    expect(calls[0].url).toBe(`/n/${REMOTE}/api/transfer/grants`);
    expect(calls[0].body).toEqual({ fromNodeId: ENTRY, destRootId: 'r2', destPath: '/data' });

    expect(calls[1].url).toBe('/api/transfer/jobs');
    expect(calls[1].body).toEqual({
      toNodeId: REMOTE,
      items: [{ rootId: 'r1', path: '/src/a.bin' }],
      destRootId: 'r2',
      destPath: '/data',
      grant: { grantId: 'g1', token: 'tok' },
      onConflict: 'skip',
    });

    expect(job.jobId).toBe('j1');
    const rows = getTransferJobsSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('self:j1');
    expect(rows[0].kind).toBe('node');
  });

  test('弹窗已关闭（signal 已 abort）时只落行，不再起进度流', async () => {
    replies = [json({ grantId: 'g1', token: 'tok', expiresAt: 9 }), json({ job: JOB })];
    const controller = new AbortController();
    controller.abort();

    await sendTransfer({
      source: { nodeId: 'self', meshId: ENTRY, rootId: 'r1', path: '/src', paths: ['/src/a.bin'] },
      dest: { nodeId: REMOTE, meshId: REMOTE, rootId: 'r2', path: '/data' },
      signal: controller.signal,
    });

    // 建单的两次请求仍然发出（关弹窗不取消已提交的任务），但没有第三次事件流请求
    expect(calls.map((call) => call.url)).toEqual([
      `/n/${REMOTE}/api/transfer/grants`,
      '/api/transfer/jobs',
    ]);
    expect(getTransferJobsSnapshot()).toHaveLength(1);
  });

  test('signal 未 abort 时照常订阅进度', async () => {
    replies = [json({ grantId: 'g1', token: 'tok', expiresAt: 9 }), json({ job: JOB })];
    const controller = new AbortController();

    await sendTransfer({
      source: { nodeId: 'self', meshId: ENTRY, rootId: 'r1', path: '/src', paths: ['/src/a.bin'] },
      dest: { nodeId: REMOTE, meshId: REMOTE, rootId: 'r2', path: '/data' },
      signal: controller.signal,
    });

    expect(calls.some((call) => call.url.endsWith('/api/transfer/jobs/j1/events'))).toBe(true);
  });

  test('覆盖策略透传', async () => {
    replies = [json({ grantId: 'g1', token: 'tok', expiresAt: 9 }), json({ job: JOB })];
    await sendTransfer({
      source: { nodeId: 'self', meshId: ENTRY, rootId: 'r1', path: '/src', paths: ['/src/a.bin'] },
      dest: { nodeId: REMOTE, meshId: REMOTE, rootId: 'r2', path: '/data' },
      onConflict: 'overwrite',
    });
    expect((calls[1].body as { onConflict: string }).onConflict).toBe('overwrite');
  });

  test('grant 失败时不建任务', async () => {
    replies = [json({ code: 'grant_invalid' }, 403)];
    const error = await sendTransfer({
      source: { nodeId: 'self', meshId: ENTRY, rootId: 'r1', path: '/src', paths: ['/src/a.bin'] },
      dest: { nodeId: REMOTE, meshId: REMOTE, rootId: 'r2', path: '/data' },
    }).catch((e: unknown) => e);

    expect((error as ApiError).code).toBe('grant_invalid');
    expect(calls).toHaveLength(1);
    expect(getTransferJobsSnapshot()).toHaveLength(0);
  });
});

describe('transferErrorKey', () => {
  test('已知契约码有自己的文案，未知码落到 unknown', () => {
    expect(transferErrorKey('quota_file_size')).toBe('devices.transfer.errors.quota_file_size');
    expect(transferErrorKey('node_unreachable')).toBe('devices.transfer.errors.node_unreachable');
    expect(transferErrorKey('weird')).toBe('devices.transfer.errors.unknown');
    expect(transferErrorKey(null)).toBe('devices.transfer.errors.unknown');
  });

  test('从 ApiError 取码；非 ApiError 一律 unknown', () => {
    expect(transferErrorKeyOf(new ApiError(410, 'gone', { code: 'grant_expired' }))).toBe(
      'devices.transfer.errors.grant_expired'
    );
    expect(transferErrorKeyOf(new Error('boom'))).toBe('devices.transfer.errors.unknown');
  });
});
