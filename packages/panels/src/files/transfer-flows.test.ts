import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { FileEntryDto } from '@vibeterm/shared';
import type { TFunction } from 'i18next';
import { createUploadStub, drainUploads, fakeRuntime, fileOf } from './transfer-test-support';

let uploadStub = createUploadStub();
type DownloadImpl = (...args: unknown[]) => Promise<unknown>;
let downloadImpl: DownloadImpl = async () => ({ name: 'x', blob: new Blob([]) });

// sonner 是浏览器 UI 库（dismiss 内部用 requestAnimationFrame），无 DOM 的单测里换成记录型替身
const toasts: string[] = [];
const fakeToast = Object.assign(() => 'id', {
  success: () => toasts.push('success'),
  error: () => toasts.push('error'),
  dismiss: () => toasts.push('dismiss'),
});
mock.module('sonner', () => ({ toast: fakeToast }));

mock.module('./bulk-transfer', () => ({
  uploadFileWithTransport: (...args: Parameters<typeof uploadStub.upload>) =>
    uploadStub.upload(...args),
  downloadFileWithTransport: (...args: unknown[]) => downloadImpl(...args),
}));

const { downloadSingleFile, uploadFilesInto } = await import('./transfer-flows');
const { cancelTransferJobEntry, getTransferJobsSnapshot, resetTransferJobsForTest } = await import(
  './transfer-jobs-store'
);
const NODE_A = 'a'.repeat(32);
const t = ((key: string) => key) as unknown as TFunction;

beforeEach(() => {
  toasts.length = 0;
  resetTransferJobsForTest();
  uploadStub = createUploadStub();
});

function files(count: number): File[] {
  return Array.from({ length: count }, (_, i) => fileOf(`f${i}.bin`));
}

function uploadDeps(nodeId: string, transferMaxBytes = 1000) {
  return { runtime: fakeRuntime(nodeId), t, rootId: 'r1', transferMaxBytes };
}

describe('uploadFilesInto', () => {
  test('本机：同一批并发 3 个文件、满员时流总数不超过预算 4（每个文件 1 条），一批只有一行', async () => {
    const run = uploadFilesInto(uploadDeps('self'), files(7), '/dest');
    await drainUploads(run, uploadStub);

    expect(uploadStub.maxInFlight()).toBe(3);
    expect(uploadStub.calls).toHaveLength(7);
    // 满员的 3+3 个文件各 1 条；最后单独跑的那个文件独占预算，用满单文件上限 4
    expect(uploadStub.calls.map((call) => call.streams)).toEqual([1, 1, 1, 1, 1, 1, 4]);
    const rows = getTransferJobsSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'upload',
      title: 'files.transfer.uploadBatch',
      state: 'done',
      itemsTotal: 7,
      itemsDone: 7,
      pct: 100,
    });
  });

  test('经中继：并发压到 2、流总预算 4（每个文件 2 条）', async () => {
    const run = uploadFilesInto(uploadDeps(NODE_A), files(5), '/dest');
    await drainUploads(run, uploadStub);

    expect(uploadStub.maxInFlight()).toBe(2);
    expect(uploadStub.calls.every((call) => call.streams === 2)).toBe(true);
  });

  test('单个文件：行标题就是文件名，独占预算用满 4 条流', async () => {
    const run = uploadFilesInto(uploadDeps('self'), files(1), '/dest');
    await drainUploads(run, uploadStub);
    expect(uploadStub.calls[0]?.streams).toBe(4);
    expect(getTransferJobsSnapshot()[0]).toMatchObject({ title: 'f0.bin', itemsTotal: 1 });
  });

  test('超限文件只提示、不上传，也不进批', async () => {
    const big = fileOf('huge.bin', 5000);
    const run = uploadFilesInto(uploadDeps('self'), [fileOf('ok.bin'), big], '/dest');
    await drainUploads(run, uploadStub);

    expect(uploadStub.calls.map((call) => call.name)).toEqual(['ok.bin']);
    expect(getTransferJobsSnapshot()[0]?.itemsTotal).toBe(1);
  });

  test('全部超限：不发请求、不留行', async () => {
    await uploadFilesInto(uploadDeps('self'), [fileOf('huge.bin', 5000)], '/dest');
    expect(uploadStub.calls).toEqual([]);
    expect(getTransferJobsSnapshot()).toEqual([]);
  });

  test('部分失败：其余照常完成，行落到失败态并记下完成个数', async () => {
    const run = uploadFilesInto(uploadDeps('self'), files(4), '/dest');
    await drainUploads(run, uploadStub, new Set(['f1.bin']));

    expect(uploadStub.calls).toHaveLength(4);
    expect(getTransferJobsSnapshot()[0]).toMatchObject({ state: 'failed', itemsDone: 3 });
    expect(toasts).toContain('error');
  });

  test('取消整批：在途中止，没开始的不再上传', async () => {
    const run = uploadFilesInto(uploadDeps('self'), files(6), '/dest');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const [row] = getTransferJobsSnapshot();
    expect(row?.cancellable).toBe(true);
    cancelTransferJobEntry(row?.key ?? '');
    for (const item of uploadStub.pending.splice(0)) {
      item.reject(new DOMException('x', 'AbortError'));
    }
    await run;

    expect(uploadStub.calls).toHaveLength(3);
    expect(getTransferJobsSnapshot()[0]?.state).toBe('cancelled');
    expect(toasts).toContain('dismiss');
  });
});

describe('downloadSingleFile', () => {
  const entry = { name: 'a.iso', path: '/srv/a.iso', size: 2048 } as unknown as FileEntryDto;

  test('成功：带上流数与总字节，保存后行落到完成态', async () => {
    let received: Record<string, unknown> = {};
    downloadImpl = async (_n, _r, _p, _name, opts) => {
      received = opts as Record<string, unknown>;
      return { name: 'a.iso', blob: new Blob(['x']), transferPath: 'direct' };
    };
    const saved: string[] = [];
    const runtime = fakeRuntime('self', (file) => {
      saved.push(file.name);
    });

    await downloadSingleFile({ runtime, t, rootId: 'r1' }, entry);

    expect(received.streams).toBe(4);
    expect(typeof received.onLegWeights).toBe('function');
    expect(saved).toEqual(['a.iso']);
    expect(getTransferJobsSnapshot()[0]).toMatchObject({
      kind: 'download',
      state: 'done',
      title: 'a.iso',
      pct: 100,
    });
    expect(getTransferJobsSnapshot()[0]?.progress.totalBytes).toBe(2048);
  });

  test('传输成功但宿主保存失败：行落到失败态', async () => {
    downloadImpl = async () => ({ name: 'a.iso', blob: new Blob(['x']) });
    const runtime = fakeRuntime('self', () => {
      throw new Error('quota');
    });
    await downloadSingleFile({ runtime, t, rootId: 'r1' }, entry);
    expect(getTransferJobsSnapshot()[0]?.state).toBe('failed');
  });

  test('传输失败：行落到失败态；用户取消：落到已取消', async () => {
    downloadImpl = async () => {
      throw new Error('Connection reset by peer');
    };
    await downloadSingleFile({ runtime: fakeRuntime(), t, rootId: 'r1' }, entry);
    expect(getTransferJobsSnapshot()[0]?.state).toBe('failed');

    resetTransferJobsForTest();
    downloadImpl = (...args) =>
      new Promise((_resolve, reject) => {
        (args[4] as { signal: AbortSignal }).signal.addEventListener('abort', () =>
          reject(new DOMException('x', 'AbortError'))
        );
      });
    const run = downloadSingleFile({ runtime: fakeRuntime(), t, rootId: 'r1' }, entry);
    cancelTransferJobEntry(getTransferJobsSnapshot()[0]?.key ?? '');
    await run;
    expect(getTransferJobsSnapshot()[0]?.state).toBe('cancelled');
  });
});
