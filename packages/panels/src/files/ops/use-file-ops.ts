// 文件变更操作（新建文件夹 / 重命名 / 删除 / 移动）的统一入口：调 API、失败出 Toast、成功静默，
// 之后刷新受影响目录的列表，并把已消失的路径从文件管理器标签页历史与侧栏展开态里清掉。

import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { FileApiError, deleteFiles, mkdirPath, moveFiles, renameFile } from '@vibeterm/api-client';
import type {
  FileOpItemResult,
  ListFileRootsResponse,
  MoveConflictPolicy,
  MoveFileItemResult,
  MoveFilesResponse,
} from '@vibeterm/shared';
import { dirname } from '@vibeterm/shared';
import type { AppRuntime, ExplorerWorkspaceState } from '@vibeterm/stores';
import { getExplorerStore } from '@vibeterm/stores/explorer';
import { useRuntime } from '@vibeterm/stores/react';
import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fileErrorKey } from '../file-tree-logic';
import { FILE_ROOTS_QUERY_KEY } from '../root-reorder';
import { fileOpErrorKey } from './file-name';

export interface MoveFilesArgs {
  rootId: string;
  paths: string[];
  destRootId: string;
  destDir: string;
  onConflict?: MoveConflictPolicy;
}

export interface RemoveOutcome {
  removed: string[];
  failed: FileOpItemResult[];
}

export interface FileOps {
  /** 成功返回新路径；失败返回 null（错误 Toast 已弹）。 */
  createFolder(rootId: string, parentDir: string, name: string): Promise<string | null>;
  rename(rootId: string, path: string, name: string): Promise<string | null>;
  remove(rootId: string, paths: string[]): Promise<RemoveOutcome>;
  move(args: MoveFilesArgs): Promise<MoveFilesResponse | null>;
}

export function parentDir(path: string): string {
  return dirname(path);
}

export function joinChildPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** `path` 是 `base` 自身或其后代。 */
export function isPathUnder(path: string, base: string): boolean {
  if (path === base) return true;
  return path.startsWith(base === '/' ? '/' : `${base}/`);
}

/** 一批路径各自的父目录，去重并保持首次出现的顺序。 */
export function touchedParentDirs(paths: readonly string[]): string[] {
  return [...new Set(paths.map(parentDir))];
}

export function partitionDeleteResults(results: readonly FileOpItemResult[]): RemoveOutcome {
  const removed: string[] = [];
  const failed: FileOpItemResult[] = [];
  for (const item of results) {
    if (item.ok) removed.push(item.path);
    else failed.push(item);
  }
  return { removed, failed };
}

/** 侧栏展开键里属于该 root、且位于 `path`（含自身）之下的路径。 */
export function expandedPathsUnder(
  expandedKeys: Iterable<string>,
  rootId: string,
  path: string
): string[] {
  const prefix = `${rootId}\n`;
  const hits: string[] = [];
  for (const key of expandedKeys) {
    if (!key.startsWith(prefix)) continue;
    const candidate = key.slice(prefix.length);
    if (isPathUnder(candidate, path)) hits.push(candidate);
  }
  return hits;
}

/**
 * `from` 改名 / 移动到 `to` 后，它名下每个展开键的去向：相对位置不变地换到 `to` 之下；
 * `to` 为 null（删除、移出本 root）时没有去向，只需收起。
 */
export function relocatedExpansionPaths(
  expandedKeys: Iterable<string>,
  rootId: string,
  from: string,
  to: string | null
): Array<{ from: string; to: string | null }> {
  return expandedPathsUnder(expandedKeys, rootId, from).map((path) => ({
    from: path,
    to: to === null ? null : rebaseUnder(path, from, to),
  }));
}

function rebaseUnder(path: string, from: string, to: string): string {
  if (path === from) return to;
  const relative = path.slice(from === '/' ? 1 : from.length + 1);
  return joinChildPath(to, relative);
}

export type BatchFailure =
  | { kind: 'none' }
  | { kind: 'all'; code: FileOpItemResult['code'] }
  | { kind: 'partial'; count: number };

/** 批量结果该弹哪种 Toast：全失败带首项原因，部分失败只报数量。 */
export function summarizeBatchFailure(results: readonly FileOpItemResult[]): BatchFailure {
  const failed = results.filter((item) => !item.ok);
  if (failed.length === 0) return { kind: 'none' };
  if (failed.length === results.length) return { kind: 'all', code: failed[0]?.code };
  return { kind: 'partial', count: failed.length };
}

/** 真正换了位置的移动项（原地 no-op 不算）。 */
export function relocatedMoveItems(
  results: readonly MoveFileItemResult[]
): Array<{ from: string; to: string }> {
  const moved: Array<{ from: string; to: string }> = [];
  for (const item of results) {
    if (item.ok && item.dest !== undefined && item.dest !== item.path) {
      moved.push({ from: item.path, to: item.dest });
    }
  }
  return moved;
}

interface OpsContext {
  runtime: AppRuntime;
  queryClient: QueryClient;
  t: TFunction;
}

function toastRequestFailure(ctx: OpsContext, failedKey: string, error: unknown): void {
  toast.error(ctx.t(failedKey), { description: ctx.t(fileOpErrorKey(error)) });
}

function toastBatchFailure(
  ctx: OpsContext,
  results: readonly FileOpItemResult[],
  keys: { failed: string; partial: string }
): void {
  const summary = summarizeBatchFailure(results);
  if (summary.kind === 'all') {
    toast.error(ctx.t(keys.failed), { description: ctx.t(fileErrorKey(summary.code)) });
  } else if (summary.kind === 'partial') {
    toast.error(ctx.t(keys.partial, { count: summary.count }));
  }
}

function invalidateListings(ctx: OpsContext, rootId: string, dirs: readonly string[]): void {
  for (const dir of dirs) {
    void ctx.queryClient.invalidateQueries({ queryKey: ['files', 'list', rootId, dir] });
  }
}

function rootPathOf(ctx: OpsContext, rootId: string): string | null {
  const cached = ctx.queryClient.getQueryData<ListFileRootsResponse>(FILE_ROOTS_QUERY_KEY);
  return cached?.roots.find((root) => root.id === rootId)?.path ?? null;
}

// 路径已不在原处（删除 / 改名 / 移走）：侧栏里它及其后代的展开态跟着搬到新位置（`to` 为 null
// 即已不在本 root，直接收起），丢掉它名下的列表缓存（同名目录日后重建时不该闪出旧内容），
// 并让文件管理器的标签页历史改指新位置或退回上级。
function forgetPath(ctx: OpsContext, rootId: string, from: string, to: string | null): void {
  const fileTree = ctx.runtime.stores.fileTree.getState();
  for (const moved of relocatedExpansionPaths(Object.keys(fileTree.expanded), rootId, from, to)) {
    fileTree.collapse(rootId, moved.from);
    if (moved.to !== null) fileTree.expand(rootId, moved.to);
  }
  ctx.queryClient.removeQueries({
    predicate: ({ queryKey: key }) =>
      key[0] === 'files' &&
      key[1] === 'list' &&
      key[2] === rootId &&
      typeof key[3] === 'string' &&
      isPathUnder(key[3], from),
  });
  const explorer = getExplorerStore().getState();
  dropStaleClipboard(explorer, ctx.runtime.nodeId, rootId, from);
  const rootPath = rootPathOf(ctx, rootId);
  if (rootPath === null) return;
  explorer.rebasePath(ctx.runtime.nodeId, rootId, from, to, rootPath);
}

// 剪贴板里记的是路径：条目被删 / 改名 / 移走后，同一路径上日后新建的东西会被当成「剪切的那个」
// 粘贴出去。受影响的路径（及其后代）还在剪贴板里就整份作废。
function dropStaleClipboard(
  explorer: Pick<ExplorerWorkspaceState, 'clipboard' | 'setClipboard'>,
  nodeId: string,
  rootId: string,
  from: string
): void {
  const { clipboard } = explorer;
  if (!clipboard || clipboard.nodeId !== nodeId || clipboard.rootId !== rootId) return;
  if (clipboard.paths.some((path) => isPathUnder(path, from))) explorer.setClipboard(null);
}

async function createFolder(
  ctx: OpsContext,
  rootId: string,
  dir: string,
  name: string
): Promise<string | null> {
  try {
    const path = joinChildPath(dir, name);
    const res = await mkdirPath({ rootId, path }, ctx.runtime.apiClient);
    invalidateListings(ctx, rootId, [dir]);
    if (res.created) return res.path;
    // mkdir 对已存在的目录是幂等成功；对「新建」这个动作来说就是重名
    toast.error(ctx.t('files.ops.createFailed'), {
      description: ctx.t(fileErrorKey('already_exists')),
    });
    return null;
  } catch (error) {
    toastRequestFailure(ctx, 'files.ops.createFailed', error);
    return null;
  }
}

async function renamePath(
  ctx: OpsContext,
  rootId: string,
  path: string,
  name: string
): Promise<string | null> {
  try {
    const res = await renameFile({ rootId, path, name }, ctx.runtime.apiClient);
    if (res.path !== path) forgetPath(ctx, rootId, path, res.path);
    invalidateListings(ctx, rootId, touchedParentDirs([path, res.path]));
    return res.path;
  } catch (error) {
    toastRequestFailure(ctx, 'files.ops.renameFailed', error);
    return null;
  }
}

async function removePaths(
  ctx: OpsContext,
  rootId: string,
  paths: string[]
): Promise<RemoveOutcome> {
  try {
    const res = await deleteFiles({ rootId, paths }, ctx.runtime.apiClient);
    const outcome = partitionDeleteResults(res.results);
    for (const path of outcome.removed) forgetPath(ctx, rootId, path, null);
    invalidateListings(ctx, rootId, touchedParentDirs(paths));
    toastBatchFailure(ctx, res.results, {
      failed: 'files.ops.deleteFailed',
      partial: 'files.ops.deletePartial',
    });
    return outcome;
  } catch (error) {
    toastRequestFailure(ctx, 'files.ops.deleteFailed', error);
    const code = error instanceof FileApiError ? error.code : undefined;
    return { removed: [], failed: paths.map((path) => ({ path, ok: false, code })) };
  }
}

async function movePaths(ctx: OpsContext, args: MoveFilesArgs): Promise<MoveFilesResponse | null> {
  try {
    const res = await moveFiles(args, ctx.runtime.apiClient);
    const sameRoot = args.destRootId === args.rootId;
    // 跨 root 的移动对源 root 的标签页而言等同于删除
    for (const { from, to } of relocatedMoveItems(res.results)) {
      forgetPath(ctx, args.rootId, from, sameRoot ? to : null);
    }
    invalidateListings(ctx, args.rootId, touchedParentDirs(args.paths));
    invalidateListings(ctx, args.destRootId, [args.destDir]);
    toastBatchFailure(ctx, res.results, {
      failed: 'files.ops.moveFailed',
      partial: 'files.ops.movePartial',
    });
    return res;
  } catch (error) {
    toastRequestFailure(ctx, 'files.ops.moveFailed', error);
    return null;
  }
}

/** 必须在某个 node 的 runtime 之下调用：API、列表缓存与展开态都是那个 node 的。 */
export function useFileOps(): FileOps {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  return useMemo<FileOps>(() => {
    const ctx: OpsContext = { runtime, queryClient, t };
    return {
      createFolder: (rootId, dir, name) => createFolder(ctx, rootId, dir, name),
      rename: (rootId, path, name) => renamePath(ctx, rootId, path, name),
      remove: (rootId, paths) => removePaths(ctx, rootId, paths),
      move: (args) => movePaths(ctx, args),
    };
  }, [runtime, queryClient, t]);
}
