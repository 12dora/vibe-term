// 侧栏文件树与文件管理器共用的传输流程（非 hook）：单文件应用内下载、逐文件上传，
// 都带可取消的进度 Toast。

import { SELF_NODE_ID, formatBytes, pickUploadStreams } from '@vibeterm/api-client';
import type { FileEntryDto } from '@vibeterm/shared';
import type { AppRuntime } from '@vibeterm/stores';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { downloadFileWithTransport, uploadFileWithTransport } from './bulk-transfer';
import { planUpload } from './file-tree-logic';
import { startTransferToast } from './transfer-toast';

export interface FileTransferDeps {
  runtime: AppRuntime;
  t: TFunction;
  rootId: string;
}

export interface FileUploadDeps extends FileTransferDeps {
  transferMaxBytes: number;
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
      { onLeg: tt.leg, signal: controller.signal, onPath: (p) => tt.setPath?.(p) },
      runtime.apiClient
    );
    await runtime.host.saveFile({ name, blob });
    tt.success(t('files.transfer.downloaded', { name: entry.name }));
  } catch {
    if (controller.signal.aborted) tt.cancel();
    else tt.fail(t('files.transfer.downloadFailed', { name: entry.name }));
  }
}

/** 逐文件上传到 `destDir`（超限只提示、不发请求）；不负责刷新列表。 */
export async function uploadFilesInto(
  { runtime, t, rootId, transferMaxBytes }: FileUploadDeps,
  files: readonly File[],
  destDir: string
): Promise<void> {
  const { accepted, oversized } = planUpload(files, transferMaxBytes);
  for (const file of oversized) {
    toast.error(
      t('files.transfer.tooLarge', { name: file.name, max: formatBytes(transferMaxBytes) })
    );
  }
  // 回落到 REST 的那一段：本机是同机直传，远端节点要经中继，按中继配额压流数
  const streams = pickUploadStreams(runtime.nodeId !== SELF_NODE_ID);
  for (const file of accepted) {
    const controller = new AbortController();
    const tt = startTransferToast(file.name, 'upload', () => controller.abort(), {
      nodeId: runtime.nodeId,
      totalBytes: file.size,
    });
    try {
      await uploadFileWithTransport(
        runtime.nodeId,
        rootId,
        destDir,
        file,
        { onLeg: tt.leg, signal: controller.signal, streams, onPath: (p) => tt.setPath?.(p) },
        runtime.apiClient
      );
      tt.success(t('files.upload.success', { name: file.name }));
    } catch {
      if (controller.signal.aborted) tt.cancel();
      else tt.fail(t('files.upload.fail', { name: file.name }));
    }
  }
}
