// 侧栏文件树与文件管理器共用的传输流程（非 hook）：单文件应用内下载、批量并发上传，
// 一次传输（一个或多个文件）对应一张可取消的进度 Toast。

import { SELF_NODE_ID, formatBytes, pickTransferStreams } from '@vibeterm/api-client';
import type { FileEntryDto } from '@vibeterm/shared';
import type { AppRuntime } from '@vibeterm/stores';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { downloadFileWithTransport, uploadFileWithTransport } from './bulk-transfer';
import { planUpload } from './file-tree-logic';
import { BATCH_STREAM_BUDGET, batchConcurrency, runTransferBatch } from './transfer-batch';
import { SaveFileError, describeTransferError } from './transfer-errors';
import { BatchProgress } from './transfer-progress';
import { summarizeUploadBatch } from './transfer-summary';
import { startBatchToast, startTransferToast } from './transfer-toast';

export interface FileTransferDeps {
  runtime: AppRuntime;
  t: TFunction;
  rootId: string;
}

export interface FileUploadDeps extends FileTransferDeps {
  transferMaxBytes: number;
}

/** 一个待上传文件及其目标目录（同一批里的文件可以落在不同目录）。 */
export interface UploadJob {
  file: File;
  destDir: string;
}

async function saveDownloaded(runtime: AppRuntime, file: { name: string; blob: Blob }) {
  try {
    await runtime.host.saveFile(file);
  } catch (error) {
    throw new SaveFileError(error);
  }
}

/** 应用内下载：流式拉取 + 进度 Toast（可取消）→ 宿主 saveFile 保存。 */
export async function downloadSingleFile(
  { runtime, t, rootId }: FileTransferDeps,
  entry: FileEntryDto
): Promise<void> {
  const controller = new AbortController();
  const tt = startTransferToast(entry.name, 'download', () => controller.abort(), {
    nodeId: runtime.nodeId,
    totalBytes: entry.size ?? undefined,
  });
  try {
    const { name, blob } = await downloadFileWithTransport(
      runtime.nodeId,
      rootId,
      entry.path,
      entry.name,
      {
        onLeg: tt.leg,
        onLegWeights: tt.legWeights,
        onPath: tt.setPath,
        signal: controller.signal,
        streams: pickTransferStreams(runtime.nodeId !== SELF_NODE_ID),
      },
      runtime.apiClient
    );
    await saveDownloaded(runtime, { name, blob });
    tt.success(t('files.transfer.downloaded', { name: entry.name }));
  } catch (error) {
    if (controller.signal.aborted) tt.cancel();
    else {
      tt.fail(
        t('files.transfer.downloadFailed', { name: entry.name }),
        describeTransferError(error, t) || undefined
      );
    }
  }
}

async function runUploadBatch(
  { runtime, t, rootId }: FileTransferDeps,
  jobs: readonly UploadJob[]
): Promise<void> {
  const names = jobs.map((job) => job.file.name);
  const progress = new BatchProgress(
    'upload',
    jobs.map(({ file }) => ({ name: file.name, size: file.size }))
  );
  const controller = new AbortController();
  const title =
    jobs.length === 1 ? (names[0] ?? '') : t('files.transfer.uploadBatch', { count: jobs.length });
  const batch = startBatchToast({
    progress,
    title,
    nodeId: runtime.nodeId,
    onCancel: () => controller.abort(),
  });
  // 本机是同机直传，远端节点要经中继；整批的并行流总数受预算约束，由执行器按在跑文件数分给各文件
  const viaRelay = runtime.nodeId !== SELF_NODE_ID;
  const outcomes = await runTransferBatch({
    progress,
    items: jobs,
    concurrency: batchConcurrency(viaRelay),
    streams: { budget: BATCH_STREAM_BUDGET, perFileMax: pickTransferStreams(viaRelay) },
    signal: controller.signal,
    onChange: batch.notify,
    run: ({ file, destDir }, io) =>
      uploadFileWithTransport(runtime.nodeId, rootId, destDir, file, io, runtime.apiClient),
  });
  batch.finish(summarizeUploadBatch(names, outcomes, controller.signal.aborted, t));
}

/**
 * 把一批文件并发上传到各自的目录（超限的只提示、不发请求）；整批共用一张 Toast，
 * 取消会中止整批。不负责刷新列表。
 */
export async function uploadFilesToDirs(
  deps: FileUploadDeps,
  jobs: readonly UploadJob[]
): Promise<void> {
  const { t, transferMaxBytes } = deps;
  const sized = jobs.map((job) => ({ job, size: job.file.size }));
  const { accepted, oversized } = planUpload(sized, transferMaxBytes);
  for (const { job } of oversized) {
    toast.error(
      t('files.transfer.tooLarge', { name: job.file.name, max: formatBytes(transferMaxBytes) })
    );
  }
  if (accepted.length === 0) return;
  await runUploadBatch(
    deps,
    accepted.map(({ job }) => job)
  );
}

/** 并发上传到同一个 `destDir`；不负责刷新列表。 */
export function uploadFilesInto(
  deps: FileUploadDeps,
  files: readonly File[],
  destDir: string
): Promise<void> {
  return uploadFilesToDirs(
    deps,
    files.map((file) => ({ file, destDir }))
  );
}
