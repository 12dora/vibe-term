// 文件管理器的下载 / 上传流程（非 hook）：单文件下载与逐文件上传复用 files/transfer-flows，
// 目录或多选走网关打包后的浏览器原生下载，文件夹上传先建目录再逐文件上传。

import type { QueryClient } from '@tanstack/react-query';
import {
  FileApiError,
  fetchFileList,
  fetchFileStat,
  fileArchiveUrl,
  mkdirPath,
  prepareArchive,
} from '@vibeterm/api-client';
import type { FileEntryDto } from '@vibeterm/shared';
import { toast } from 'sonner';
import { fileOpErrorKey, joinChildPath } from '../../files/ops';
import { type FileUploadDeps, uploadFilesInto } from '../../files/transfer-flows';
import type { FolderUploadFile, FolderUploadPlan } from './folder-upload';
import {
  type ConflictProbeIo,
  type UploadConflictChoice,
  conflictPromptNames,
  planUploadConflicts,
  probeExistence,
  selectUploadFiles,
} from './upload-conflicts';

export { downloadSingleFile, uploadFilesInto } from '../../files/transfer-flows';

export interface TransferFlowDeps extends FileUploadDeps {
  queryClient: QueryClient;
}

// 与文件管理器列表的 staleTime 一致：刚取过的列表不必为查冲突再取一遍
const CONFLICT_LISTING_FRESH_MS = 2000;

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

/** 一次上传触及的全部目录（绝对路径，去重）：目标目录、新建的目录、收到文件的目录 */
export function touchedUploadDirs(plan: FolderUploadPlan, destDir: string): string[] {
  const dirs = new Set<string>([destDir]);
  for (const dir of plan.dirs) dirs.add(resolveUploadDir(destDir, dir));
  for (const { relDir } of plan.files) dirs.add(resolveUploadDir(destDir, relDir));
  return Array.from(dirs);
}

/** 上传一棵目录树：建目录 → 各文件传进对应目录 → 刷新所有触及目录的列表。 */
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
    // 别的分栏或侧栏可能正开着其中某个子目录，只刷目标目录会让它们停在旧列表上
    for (const dir of touchedUploadDirs(plan, destDir)) invalidateListing(deps, dir);
  }
}

function isMissingDirError(error: unknown): boolean {
  return (
    error instanceof FileApiError &&
    (error.code === 'not_found' || error.code === 'not_a_directory')
  );
}

function conflictProbeIo(
  { runtime, queryClient, rootId }: TransferFlowDeps,
  destDir: string
): ConflictProbeIo {
  return {
    // 缓存够新就直接用，否则现取一次（顺带更新缓存）
    list: async (relDir) => {
      const dir = resolveUploadDir(destDir, relDir);
      try {
        const listing = await queryClient.fetchQuery({
          queryKey: ['files', 'list', rootId, dir],
          queryFn: () => fetchFileList(rootId, dir, runtime.apiClient),
          staleTime: CONFLICT_LISTING_FRESH_MS,
        });
        return {
          names: listing.entries.map((entry) => entry.name),
          truncated: listing.truncated,
        };
      } catch (error) {
        return isMissingDirError(error) ? 'missing' : 'unknown';
      }
    },
    // 只有明确的 not_found 才算「确定不存在」；其它错误原样抛出，由调用方记为没查清
    exists: async (relDir, name) => {
      const path = joinChildPath(resolveUploadDir(destDir, relDir), name);
      try {
        await fetchFileStat(rootId, path, runtime.apiClient);
        return true;
      } catch (error) {
        if (error instanceof FileApiError && error.code === 'not_found') return false;
        throw error;
      }
    },
  };
}

export type AskUploadConflict = (
  names: readonly string[],
  uncertain?: boolean
) => Promise<UploadConflictChoice>;

/**
 * 文件管理器的上传入口：先查同名冲突，有冲突或有没查清的就问用户（取消 / 跳过 / 替换）再传。
 * 网关落盘是 rename 覆盖目标，不问就会静默丢掉原文件；「跳过」只传确定不存在的。
 */
export async function uploadPlanGuarded(
  deps: TransferFlowDeps,
  plan: FolderUploadPlan,
  destDir: string,
  ask: AskUploadConflict
): Promise<void> {
  if (plan.files.length === 0 && plan.dirs.length === 0) return;
  const existence = await probeExistence(plan, conflictProbeIo(deps, destDir));
  const conflictPlan = planUploadConflicts(plan.files, existence);
  const names = conflictPromptNames(conflictPlan);
  if (names.length === 0) {
    await uploadPlanInto(deps, plan, destDir);
    return;
  }
  const uncertain = conflictPlan.unknown.length > 0;
  const files = selectUploadFiles(plan.files, conflictPlan, await ask(names, uncertain));
  if (files) await uploadPlanInto(deps, { files, dirs: plan.dirs }, destDir);
}
