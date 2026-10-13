// 命令分发：键盘快捷键、右键菜单、工具条按钮都走这一处，行为只有一份。

import type { FileEntryDto } from '@vibeterm/shared';
import { explorerParentPath } from '@vibeterm/stores/explorer';

import type { RefObject } from 'react';
import { useMemo } from 'react';
import type { ExplorerActions, ExplorerMenuCommand, ExplorerMenuTarget } from './actions';
import { type ExplorerCommandState, isCommandAllowed } from './command-policy';
import { primaryEntry } from './explorer-derive';
import { EMPTY_SELECTION, isDirectoryEntry, selectAll } from './model';
import type { ExplorerOps, ExplorerOpsContext } from './use-explorer-ops';

export interface ExplorerCommandScope {
  /** 命令作用的条目：键盘 = 当前选择；菜单 = 右键命中的那批 */
  targets: readonly FileEntryDto[];
  /** 「打开」作用的那一项 */
  primary: FileEntryDto | null;
  /** 粘贴的目标目录 */
  pasteDir: string;
}

export interface ExplorerCommandContext extends ExplorerOpsContext {
  ops: ExplorerOps;
  actions: ExplorerActions;
  /** 当前可见条目 */
  entries: readonly FileEntryDto[];
  selectedEntries: readonly FileEntryDto[];
  cutPaths: ReadonlySet<string>;
  listingReady: boolean;
  filterInputRef: RefObject<HTMLInputElement | null>;
  refresh(): void;
}

type Latest = { readonly current: ExplorerCommandContext };
type Handler = (ctx: ExplorerCommandContext, scope: ExplorerCommandScope) => void;

function clearSelection(ctx: ExplorerCommandContext): void {
  ctx.selection.setSelection(EMPTY_SELECTION);
  ctx.dialogs.setRenamingPath(null);
  ctx.dialogs.setPendingFolder(null);
  if (ctx.cutPaths.size > 0) ctx.props.onClipboardChange(null);
}

function selectEverything(ctx: ExplorerCommandContext): void {
  const order = ctx.entries.map((entry) => entry.path);
  ctx.selection.setSelection(selectAll(order));
}

function focusFilter(ctx: ExplorerCommandContext): void {
  const input = ctx.filterInputRef.current;
  if (!input) return;
  input.focus();
  input.select();
}

const HANDLERS: Record<ExplorerMenuCommand, Handler> = {
  open: (ctx, scope) => {
    if (scope.primary) ctx.ops.open(scope.primary);
  },
  openInNewTab: (ctx, scope) => {
    if (scope.primary) ctx.props.onOpenInNewTab(scope.primary.path);
  },
  up: (ctx) => ctx.props.onUp(ctx.root.path),
  back: (ctx) => ctx.props.onBack(),
  forward: (ctx) => ctx.props.onForward(),
  refresh: (ctx) => ctx.refresh(),
  selectAll: selectEverything,
  clearSelection,
  rename: (ctx, scope) => {
    const [target] = scope.targets;
    if (target) ctx.ops.startRename(target);
  },
  delete: (ctx, scope) => ctx.ops.requestDelete(scope.targets),
  copy: (ctx, scope) => ctx.ops.setClipboard('copy', scope.targets),
  cut: (ctx, scope) => ctx.ops.setClipboard('cut', scope.targets),
  paste: (ctx, scope) => ctx.ops.paste(scope.pasteDir),
  newFolder: (ctx) => ctx.ops.startNewFolder(),
  focusFilter,
  newTab: (ctx) => ctx.props.onCommand?.('newTab'),
  closeTab: (ctx) => ctx.props.onCommand?.('closeTab'),
  split: (ctx) => ctx.props.onCommand?.('split'),
  showShortcuts: (ctx) => ctx.dialogs.setShortcutsOpen(true),
  download: (ctx, scope) => ctx.actions.download(scope.targets),
  copyPath: (ctx, scope) => {
    const [target] = scope.targets;
    if (target) ctx.actions.copyPath(target);
  },
  upload: (ctx) => ctx.actions.openFilePicker(ctx.props.path),
  uploadFolder: (ctx) => ctx.actions.openFilePicker(ctx.props.path, { directory: true }),
};

export function hasPasteSource(ctx: Pick<ExplorerCommandContext, 'props'>): boolean {
  const { clipboard } = ctx.props;
  return clipboard !== null && clipboard.paths.length > 0;
}

export function commandStateOf(
  ctx: ExplorerCommandContext,
  scope: ExplorerCommandScope
): ExplorerCommandState {
  return {
    selectedCount: scope.targets.length,
    primaryIsDirectory: scope.primary !== null && isDirectoryEntry(scope.primary),
    canPaste: hasPasteSource(ctx),
    canBack: ctx.props.canBack,
    canForward: ctx.props.canForward,
    canUp: explorerParentPath(ctx.props.path, ctx.root.path) !== null,
    hasCut: ctx.cutPaths.size > 0,
    listingReady: ctx.listingReady,
  };
}

/** 键盘与工具条：作用于当前选择，粘贴进当前目录。 */
export function selectionScope(ctx: ExplorerCommandContext): ExplorerCommandScope {
  const targets = ctx.selectedEntries;
  return {
    targets,
    primary: primaryEntry(targets, ctx.selection.selection.focus),
    pasteDir: ctx.props.path,
  };
}

/** 右键菜单：作用于命中的条目；单个目录上的「粘贴」是粘进那个目录。 */
export function menuScope(
  ctx: ExplorerCommandContext,
  target: ExplorerMenuTarget
): ExplorerCommandScope {
  const targets = target.kind === 'items' ? target.entries : [];
  const single = targets.length === 1 ? targets[0] : undefined;
  return {
    targets,
    primary: primaryEntry(targets, ctx.selection.selection.focus),
    pasteDir: single && isDirectoryEntry(single) ? single.path : ctx.props.path,
  };
}

function dispatch(
  ctx: ExplorerCommandContext,
  command: ExplorerMenuCommand,
  scope: ExplorerCommandScope
): boolean {
  if (!isCommandAllowed(command, commandStateOf(ctx, scope))) return false;
  HANDLERS[command](ctx, scope);
  return true;
}

export interface ExplorerCommands {
  /** 返回是否执行了（不满足前提时什么都不做并返回 false） */
  run(command: ExplorerMenuCommand): boolean;
  runFromMenu(command: ExplorerMenuCommand): boolean;
}

export function useExplorerCommands(latest: Latest): ExplorerCommands {
  return useMemo<ExplorerCommands>(
    () => ({
      run: (command) => dispatch(latest.current, command, selectionScope(latest.current)),
      runFromMenu: (command) => {
        const ctx = latest.current;
        return dispatch(ctx, command, menuScope(ctx, ctx.dialogs.menu.target));
      },
    }),
    [latest]
  );
}
