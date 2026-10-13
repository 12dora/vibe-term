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
import { clipboardItems, listingNames } from './explorer-derive';
import { type ExplorerDropDest, isDirectoryEntry } from './model';
import { requestFromClipboard } from './transfer-request';
import type { ExplorerDialogs } from './use-explorer-dialogs';
import type { ExplorerSelectionApi } from './use-explorer-selection';
import type { KeyedUpdate } from './use-keyed-state';

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
  setHiddenPaths(update: KeyedUpdate<ReadonlySet<string>>): void;
  focusView(): void;
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

/** 新条目落在仍在显示的目录里时：等它进列表后选中并高亮。 */
function revealCreated(ctx: ExplorerOpsContext, rootId: string, path: string): void {
  if (ctx.props.rootId !== rootId || dirname(path) !== ctx.props.path) return;
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
  if (created === null) return;
  // 筛选条件可能把新文件夹挡在外面
  latest.current.setQuery('');
  revealCreated(latest.current, rootId, created);
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
  // 先从视图里拿掉，接口返回后再对账：失败的会原样回来
  ctx.setHiddenPaths((current) => new Set([...current, ...paths]));
  const outcome = await ctx.fileOps.remove(rootId, paths);
  const after = latest.current;
  dropRemovedFromCache(after, rootId, path, outcome.removed);
  if (after.props.rootId !== rootId || after.props.path !== path) return;
  after.setHiddenPaths((current) => {
    const next = new Set(current);
    for (const item of paths) next.delete(item);
    return next;
  });
  after.focusView();
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

function paste(ctx: ExplorerOpsContext, destDir: string): void {
  const { clipboard, rootId } = ctx.props;
  if (!clipboard) return;
  const sameRoot = clipboard.nodeId === ctx.runtime.nodeId && clipboard.rootId === rootId;
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
