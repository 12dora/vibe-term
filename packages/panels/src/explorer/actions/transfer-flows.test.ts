import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import {
  createUploadStub,
  drainUploads,
  fakeRuntime,
  fileOf,
} from '../../files/transfer-test-support';

let uploadStub = createUploadStub();

mock.module('../../files/bulk-transfer', () => ({
  uploadFileWithTransport: (...args: Parameters<typeof uploadStub.upload>) =>
    uploadStub.upload(...args),
  downloadFileWithTransport: async () => ({ name: 'x', blob: new Blob([]) }),
}));

const { touchedUploadDirs, uploadPlanInto, resolveUploadDir } = await import('./transfer-flows');
const { getTransferJobsSnapshot, resetTransferJobsForTest } = await import(
  '../../files/transfer-jobs-store'
);
const t = ((key: string) => key) as unknown as TFunction;

beforeEach(() => {
  resetTransferJobsForTest();
  uploadStub = createUploadStub();
});

interface Harness {
  deps: Parameters<typeof uploadPlanInto>[0];
  events: string[];
  invalidated: unknown[];
}

function harness(nodeId = 'self', mkdirStatus = 200): Harness {
  const events: string[] = [];
  const invalidated: unknown[] = [];
  const runtime = fakeRuntime(nodeId, undefined, (path, init) => {
    if (path === '/api/files/mkdir') {
      events.push(`mkdir ${(JSON.parse(String(init?.body)) as { path: string }).path}`);
      const body = mkdirStatus === 200 ? {} : { code: 'permission_denied' };
      return new Response(JSON.stringify(body), {
        status: mkdirStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}');
  });
  const queryClient = new QueryClient();
  queryClient.invalidateQueries = ((filters: { queryKey: unknown }) => {
    invalidated.push(filters.queryKey);
    return Promise.resolve();
  }) as QueryClient['invalidateQueries'];
  return {
    deps: { runtime, t, rootId: 'r1', transferMaxBytes: 1000, queryClient },
    events,
    invalidated,
  };
}

const plan = {
  dirs: ['sub', 'sub/deep'],
  files: [
    { file: fileOf('a.txt'), relDir: '' },
    { file: fileOf('b.txt'), relDir: 'sub' },
    { file: fileOf('c.txt'), relDir: 'sub' },
    { file: fileOf('d.txt'), relDir: 'sub/deep' },
    { file: fileOf('e.txt'), relDir: 'sub/deep' },
  ],
};

describe('uploadPlanInto', () => {
  test('先建目录，再把所有目录下的文件作为同一批并发上传', async () => {
    const h = harness();
    const run = uploadPlanInto(h.deps, plan, '/root/dest');
    await drainUploads(run, uploadStub);

    // 跨目录也共用一个工作池：峰值 3，而不是每个目录各自串行
    expect(uploadStub.maxInFlight()).toBe(3);
    expect(h.events).toEqual(['mkdir /root/dest/sub', 'mkdir /root/dest/sub/deep']);
    const uploaded = uploadStub.calls.map((call) => `${call.destDir}/${call.name}`).sort();
    expect(uploaded).toEqual([
      '/root/dest/a.txt',
      '/root/dest/sub/b.txt',
      '/root/dest/sub/c.txt',
      '/root/dest/sub/deep/d.txt',
      '/root/dest/sub/deep/e.txt',
    ]);
    const rows = getTransferJobsSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemsTotal: 5, itemsDone: 5, state: 'done' });
  });

  test('结束后每个触及的目录各刷新一次列表', async () => {
    const h = harness();
    await drainUploads(uploadPlanInto(h.deps, plan, '/root/dest'), uploadStub);
    expect(h.invalidated).toEqual(
      touchedUploadDirs(plan, '/root/dest').map((dir) => ['files', 'list', 'r1', dir])
    );
  });

  test('经中继时整批并发压到 2', async () => {
    const h = harness('b'.repeat(32));
    await drainUploads(uploadPlanInto(h.deps, plan, '/root/dest'), uploadStub);
    expect(uploadStub.maxInFlight()).toBe(2);
  });

  test('超限文件被排除，其余照常上传', async () => {
    const h = harness();
    const withBig = { ...plan, files: [...plan.files, { file: fileOf('big', 5000), relDir: '' }] };
    await drainUploads(uploadPlanInto(h.deps, withBig, '/root/dest'), uploadStub);
    expect(uploadStub.calls.map((call) => call.name)).not.toContain('big');
    expect(uploadStub.calls).toHaveLength(5);
  });

  test('建目录失败：不上传任何文件', async () => {
    const h = harness('self', 403);
    await uploadPlanInto(h.deps, plan, '/root/dest');
    expect(uploadStub.calls).toEqual([]);
    expect(getTransferJobsSnapshot()).toEqual([]);
  });
});

describe('resolveUploadDir', () => {
  test('相对目录为空时就是目标目录自身', () => {
    expect(resolveUploadDir('/root/dest', '')).toBe('/root/dest');
    expect(resolveUploadDir('/root/dest', 'sub/deep')).toBe('/root/dest/sub/deep');
  });
});
