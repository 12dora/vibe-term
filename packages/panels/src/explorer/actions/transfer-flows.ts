// 文件管理器的下载 / 上传流程（非 hook）：单文件下载与逐文件上传复用 files/transfer-flows，
// 目录或多选走网关打包后的浏览器原生下载，文件夹上传先建目录再逐文件上传。

import type { QueryClient } from '@tanstack/react-query';
import { fileArchiveUrl, mkdirPath, prepareArchive } from '@vibeterm/api-client';
import type { FileEntryDto } from '@vibeterm/shared';
import { toast } from 'sonner';
import { fileOpErrorKey, joinChildPath } from '../../files/ops';
import { type FileUploadDeps, uploadFilesInto } from '../../files/transfer-flows';
import type { FolderUploadFile, FolderUploadPlan } from './folder-upload';

export { downloadSingleFile, uploadFilesInto } from '../../files/transfer-flows';

export interface TransferFlowDeps extends FileUploadDeps {
  queryClient: QueryClient;
}

/** 相对目录（'' = 目标目录自身）落到目标目录下的绝对路径 */
export function resolveUploadDir(destDir: string, relDir: string): string {
  return relDir ? joinChildPath(destDir, relDir) : destDir;
}

/** 按相对目录分组，保持首次出现的顺序 */
export function groupByRelDir(files: readonly FolderUploadFile[]): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const { file, relDir } of files) {
    const group = groups.get(relDir);
    if (group) group.push(file);
    else groups.set(relDir, [file]);
  }
  return groups;
}

// 打包流没有 Content-Length，也不经 ApiClient：交给浏览器原生下载，进度看浏览器下载区。
function clickDownloadLink(href: string, name: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export async function downloadArchive(
  { runtime, t, rootId }: TransferFlowDeps,
  entries: readonly FileEntryDto[]
): Promise<void> {
  const toastId = toast.loading(t('explorer.archive.preparing'));
  try {
    const { archiveId, name } = await prepareArchive(
      { rootId, paths: entries.map((entry) => entry.path) },
      runtime.apiClient
    );
    clickDownloadLink(fileArchiveUrl(runtime.nodeId, archiveId), name);
    toast.dismiss(toastId);
  } catch (error) {
    toast.error(t('explorer.archive.failed'), {
      id: toastId,
      description: t(fileOpErrorKey(error)),
    });
  }
}

export function invalidateListing(deps: TransferFlowDeps, dir: string): void {
  void deps.queryClient.invalidateQueries({ queryKey: ['files', 'list', deps.rootId, dir] });
}

// 父目录在前逐个建；任何一个失败就整体放弃，避免文件散落到错误的层级。
async function createDirectories(
  { runtime, t, rootId }: TransferFlowDeps,
  dirs: readonly string[],
  destDir: string
): Promise<boolean> {
  for (const dir of dirs) {
    try {
      await mkdirPath(
        { rootId, path: resolveUploadDir(destDir, dir), recursive: true },
        runtime.apiClient
      );
    } catch (error) {
      toast.error(t('files.upload.fail', { name: dir }), {
        description: t(fileOpErrorKey(error)),
      });
      return false;
    }
  }
  return true;
}

/** 上传一棵目录树：建目录 → 各文件传进对应目录 → 最后刷新一次目标目录。 */
export async function uploadPlanInto(
  deps: TransferFlowDeps,
  plan: FolderUploadPlan,
  destDir: string
): Promise<void> {
  if (plan.files.length === 0 && plan.dirs.length === 0) return;
  try {
    if (!(await createDirectories(deps, plan.dirs, destDir))) return;
    for (const [relDir, files] of groupByRelDir(plan.files)) {
      await uploadFilesInto(deps, files, resolveUploadDir(destDir, relDir));
    }
  } finally {
    invalidateListing(deps, destDir);
  }
}
