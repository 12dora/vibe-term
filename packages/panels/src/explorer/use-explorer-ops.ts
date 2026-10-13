// 会改动文件或剪贴板的操作：打开、重命名、新建文件夹、删除、复制 / 剪切 / 粘贴。
// 全是读「最新上下文」的普通函数，钩子只负责把它们包成稳定引用。

import type { QueryClient } from '@tanstack/react-query';
import type { FileEntryDto, FileRootDto, ListFilesResponse } from '@vibeterm/shared';
import { dirname } from '@vibeterm/shared';
import { type AppRuntime, fileRoute, hostAppPath } from '@vibeterm/stores';
import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { uniqueChildName } from '../files/ops/file-name';
import type { FileOps } from '../files/ops/use-file-ops';
import { fileListQueryKey } from '../files/use-directory-listing';
import type { ExplorerBrowserProps } from './browser-types';
import { clipboardItems, listingNames, liveClipboard } from './explorer-derive';
import { type ExplorerDropDest, isDirectoryEntry } from './model';
import { beginPendingDelete, pendingDeletePaths, pendingDeleteScope } from './pending-deletes';
import { requestFromClipboard } from './transfer-request';
import type { ExplorerDialogs } from './use-explorer-dialogs';
import type { ExplorerSelectionApi } from './use-explorer-selection';

export interface ExplorerOpsContext {
  props: ExplorerBrowserProps;
  root: FileRootDto;
  runtime: AppRuntime;
  queryClient: QueryClient;
  t: TFunction;
  fileOps: FileOps;
  /** 当前目录的全部条目（未筛选） */
  allEntries: readonly FileEntryDto[];
  selection: ExplorerSelectionApi;
  dialogs: ExplorerDialogs;
  setQuery(query: string): void;
  /** 异步操作落定后把焦点交还视图——仅当本浏览器仍是键盘属主且焦点没有去别处 */
  reclaimFocus(): void;
  scrollViewToTop(): void;
}

type Latest = { readonly current: ExplorerOpsContext };

export interface ExplorerOps {
  open(entry: FileEntryDto): void;
  startRename(entry: FileEntryDto): void;
  commitRename(path: string, name: string): void;
  startNewFolder(): void;
  commitNewFolder(name: string): void;
  requestDelete(entries: readonly FileEntryDto[]): void;
  confirmDelete(): void;
  setClipboard(mode: 'copy' | 'cut', entries: readonly FileEntryDto[]): void;
  paste(destDir: string): void;
  dropDest(dir: string): ExplorerDropDest;
  destNames(dir: string): ReadonlySet<string> | null;
}

function dropDest(ctx: ExplorerOpsContext, dir: string): ExplorerDropDest {
  return {
    nodeId: ctx.runtime.nodeId,
    deviceId: ctx.root.deviceId,
    rootId: ctx.props.rootId,
    dir,
  };
}

function destNames(ctx: ExplorerOpsContext, dir: string): ReadonlySet<string> | null {
  const key = fileListQueryKey(ctx.props.rootId, dir);
  return listingNames(ctx.queryClient.getQueryData<ListFilesResponse>(key));
}

function openEntry(ctx: ExplorerOpsContext, entry: FileEntryDto): void {
  if (isDirectoryEntry(entry)) {
    ctx.props.onNavigate(entry.path);
    return;
  }
  const { host } = ctx.runtime;
  host.navigate(hostAppPath(host, fileRoute(ctx.props.rootId, entry.path)));
}

/** 异步操作落定时，用户是否还停在发起它的那个目录。不在了就不能再动界面状态。 */
function isStillAt(ctx: ExplorerOpsContext, rootId: string, dir: string): boolean {
  return ctx.props.rootId === rootId && ctx.props.path === dir;
}

/** 新条目落在仍在显示的目录里时：等它进列表后选中并高亮。 */
function revealCreated(ctx: ExplorerOpsContext, rootId: string, path: string): void {
  if (!isStillAt(ctx, rootId, dirname(path))) return;
  ctx.selection.selectWhenListed(path);
  ctx.dialogs.flash(path);
}

async function commitRename(latest: Latest, path: string, name: string): Promise<void> {
  const ctx = latest.current;
  const { rootId } = ctx.props;
  ctx.dialogs.setRenamingPath(null);
  const renamed = await ctx.fileOps.rename(rootId, path, name);
  if (renamed !== null && renamed !== path) revealCreated(latest.current, rootId, renamed);
}

function startNewFolder(ctx: ExplorerOpsContext): void {
  const taken = new Set(ctx.allEntries.map((entry) => entry.name));
  ctx.dialogs.setRenamingPath(null);
  ctx.dialogs.setPendingFolder({
    name: uniqueChildName(ctx.t('files.ops.defaultFolderName'), taken),
  });
  // 占位行排在最前
  ctx.scrollViewToTop();
}

async function commitNewFolder(latest: Latest, name: string): Promise<void> {
  const ctx = latest.current;
  const { rootId, path } = ctx.props;
  ctx.dialogs.setPendingFolder(null);
  const created = await ctx.fileOps.createFolder(rootId, path, name);
  const after = latest.current;
  if (created === null || !isStillAt(after, rootId, path)) return;
  // 筛选条件可能把新文件夹挡在外面
  after.setQuery('');
  revealCreated(after, rootId, created);
}

function dropRemovedFromCache(
  ctx: ExplorerOpsContext,
  rootId: string,
  dir: string,
  removed: readonly string[]
): void {
  if (removed.length === 0) return;
  const gone = new Set(removed);
  ctx.queryClient.setQueryData<ListFilesResponse>(fileListQueryKey(rootId, dir), (current) =>
    current
      ? { ...current, entries: current.entries.filter((entry) => !gone.has(entry.path)) }
      : current
  );
}

async function confirmDelete(latest: Latest): Promise<void> {
  const ctx = latest.current;
  const targets = ctx.dialogs.deleteTargets;
  if (!targets || targets.length === 0) return;
  const { rootId, path } = ctx.props;
  const paths = targets.map((entry) => entry.path);
  ctx.dialogs.setDeleteTargets(null);
  // 先从视图里拿掉；请求落定即撤销隐藏（成功的已从缓存里摘掉，失败的原样回来），
  // 这一步与用户此刻在哪个目录无关
  const settle = beginPendingDelete(pendingDeleteScope(ctx.runtime.nodeId, rootId, path), paths);
  try {
    const outcome = await ctx.fileOps.remove(rootId, paths);
    dropRemovedFromCache(latest.current, rootId, path, outcome.removed);
  } finally {
    settle();
  }
  const after = latest.current;
  if (isStillAt(after, rootId, path)) after.reclaimFocus();
}

function setClipboard(
  ctx: ExplorerOpsContext,
  mode: 'copy' | 'cut',
  entries: readonly FileEntryDto[]
): void {
  if (entries.length === 0) return;
  ctx.props.onClipboardChange({
    mode,
    nodeId: ctx.runtime.nodeId,
    rootId: ctx.props.rootId,
    deviceId: ctx.root.deviceId,
    paths: entries.map((entry) => entry.path),
  });
}

/** 当前目录的完整列表（未截断）；拿不到或不完整时为 undefined。 */
function authoritativeEntries(ctx: ExplorerOpsContext): readonly FileEntryDto[] | undefined {
  const key = fileListQueryKey(ctx.props.rootId, ctx.props.path);
  const listing = ctx.queryClient.getQueryData<ListFilesResponse>(key);
  return listing && !listing.truncated ? ctx.allEntries : undefined;
}

function paste(ctx: ExplorerOpsContext, destDir: string): void {
  const { rootId, path } = ctx.props;
  const { nodeId } = ctx.runtime;
  const held = ctx.props.clipboard;
  if (!held) return;
  const here = { nodeId, rootId, dir: path, entries: authoritativeEntries(ctx) };
  // 列表里已经没有的路径是确定失效的：把剪贴板改正（全部失效则清空），免得下次再用到旧路径
  const settled = liveClipboard(held, here);
  if (settled !== held) ctx.props.onClipboardChange(settled);
  if (!settled) return;
  // 正在删除的路径结果未定（删除可能失败）：只从这一次粘贴里拿掉，不改剪贴板
  const clipboard = liveClipboard(settled, {
    ...here,
    vanishing: pendingDeletePaths(pendingDeleteScope(nodeId, rootId, path)),
  });
  if (!clipboard) return;
  const sameRoot = clipboard.nodeId === nodeId && clipboard.rootId === rootId;
  const items = clipboardItems(clipboard, sameRoot ? ctx.allEntries : []);
  const request = requestFromClipboard(
    clipboard,
    items.names,
    items.hasDirectory,
    dropDest(ctx, destDir),
    destNames(ctx, destDir)
  );
  if (request) ctx.props.onTransfer(request);
}

export function useExplorerOps(latest: Latest): ExplorerOps {
  return useMemo<ExplorerOps>(
    () => ({
      open: (entry) => openEntry(latest.current, entry),
      startRename: (entry) => {
        latest.current.dialogs.setPendingFolder(null);
        latest.current.dialogs.setRenamingPath(entry.path);
      },
      commitRename: (path, name) => void commitRename(latest, path, name),
      startNewFolder: () => startNewFolder(latest.current),
      commitNewFolder: (name) => void commitNewFolder(latest, name),
      requestDelete: (entries) => {
        if (entries.length > 0) latest.current.dialogs.setDeleteTargets(entries);
      },
      confirmDelete: () => void confirmDelete(latest),
      setClipboard: (mode, entries) => setClipboard(latest.current, mode, entries),
      paste: (destDir) => paste(latest.current, destDir),
      dropDest: (dir) => dropDest(latest.current, dir),
      destNames: (dir) => destNames(latest.current, dir),
    }),
    [latest]
  );
}
