// 一个标签页浏览器的全部状态与派生数据：列表、筛选、选择、临时界面状态、文件操作、命令、拖放。
// 只做组装，具体逻辑分在各个 use-explorer-* 文件里。

import { useQueryClient } from '@tanstack/react-query';
import type { FileEntryDto, FileRootDto } from '@vibeterm/shared';
import { explorerParentPath } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';
import type { MouseEvent, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFileOps } from '../files/ops/use-file-ops';
import { type ExplorerMenuTarget, useExplorerActions } from './actions';
import { focusView, revealRow, scrollViewToTop } from './browser-dom';
import type { ExplorerBrowserProps } from './browser-types';
import {
  contentKindOf,
  cutPathsOf,
  explorerStatus,
  menuEntriesOf,
  selectedEntriesOf,
} from './explorer-derive';
import { filterEntries, sortEntries } from './model';
import { useCoarsePointer } from './use-coarse-pointer';
import {
  type ExplorerCommandContext,
  hasPasteSource,
  useExplorerCommands,
} from './use-explorer-commands';
import { useExplorerListing } from './use-explorer-data';
import { useExplorerDialogs } from './use-explorer-dialogs';
import { useExplorerDrop } from './use-explorer-drop';
import { type ExplorerOpsContext, useExplorerOps } from './use-explorer-ops';
import { useExplorerSelection } from './use-explorer-selection';
import { useKeyedState, useLatest } from './use-keyed-state';

const NO_ENTRIES: readonly FileEntryDto[] = [];
const NO_PATHS: ReadonlySet<string> = new Set<string>();

/** 目录被删（列表 404）时自动退到上一级；每个位置只触发一次，退到根为止。 */
function useAutoUpOnMissing(locationKey: string, missing: boolean, onUp: () => void): void {
  const onUpRef = useLatest(onUp);
  const handledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!missing || handledFor.current === locationKey) return;
    handledFor.current = locationKey;
    onUpRef.current();
  }, [locationKey, missing, onUpRef]);
}

function useExplorerEntries(props: ExplorerBrowserProps, locationKey: string) {
  const { rootId, path, showHidden, sort } = props;
  const listing = useExplorerListing(rootId, path);
  const allEntries = listing.entries ?? NO_ENTRIES;
  const [query, setQuery] = useKeyedState(locationKey, '');
  // 正在删除的条目先从视图里拿掉
  const [hiddenPaths, setHiddenPaths] = useKeyedState(locationKey, NO_PATHS);
  const entries = useMemo(() => {
    const present =
      hiddenPaths.size > 0
        ? allEntries.filter((entry) => !hiddenPaths.has(entry.path))
        : allEntries;
    return sortEntries(filterEntries(present, { showHidden, query }), sort);
  }, [allEntries, hiddenPaths, showHidden, sort, query]);
  const order = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const { refetch } = listing.query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  return {
    listing,
    allEntries,
    listingReady: listing.entries !== undefined,
    entries,
    order,
    query,
    setQuery,
    setHiddenPaths,
    refresh,
  };
}

function useContextMenuOpener(latest: { readonly current: ExplorerCommandContext }) {
  return useCallback(
    (entry: FileEntryDto | null, event: MouseEvent) => {
      event.preventDefault();
      const current = latest.current;
      const target: ExplorerMenuTarget = entry
        ? { kind: 'items', entries: menuEntriesOf(entry, current.selectedEntries) }
        : { kind: 'background' };
      current.dialogs.openMenu(target, { x: event.clientX, y: event.clientY });
    },
    [latest]
  );
}

/** 选择、临时界面状态与文件操作：命令分发和拖放都建立在它之上。 */
function useExplorerCore(
  props: ExplorerBrowserProps,
  root: FileRootDto,
  rootRef: RefObject<HTMLDivElement | null>
) {
  const { rootId, path } = props;
  const locationKey = `${rootId}\n${path}`;
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const fileOps = useFileOps();
  const data = useExplorerEntries(props, locationKey);
  const { entries, allEntries } = data;

  const selection = useExplorerSelection({
    location: { rootId, path },
    order: data.order,
    ready: data.listingReady,
    onReveal: (target) => revealRow(rootRef.current, target),
  });
  const { selected } = selection.selection;
  const selectedEntries = useMemo(() => selectedEntriesOf(entries, selected), [entries, selected]);
  const dialogs = useExplorerDialogs(locationKey);
  const actions = useExplorerActions({ rootId, root, dir: path, entries });
  const cutPaths = useMemo(
    () => cutPathsOf(props.clipboard, runtime.nodeId, rootId),
    [props.clipboard, runtime.nodeId, rootId]
  );

  const opsContext: ExplorerOpsContext = {
    props,
    root,
    runtime,
    queryClient,
    t,
    fileOps,
    allEntries,
    selection,
    dialogs,
    setQuery: data.setQuery,
    setHiddenPaths: data.setHiddenPaths,
    focusView: () => focusView(rootRef.current),
    scrollViewToTop: () => scrollViewToTop(rootRef.current),
  };
  const ops = useExplorerOps(useLatest(opsContext));
  return {
    locationKey,
    runtime,
    data,
    selection,
    selectedEntries,
    dialogs,
    actions,
    cutPaths,
    ops,
    opsContext,
  };
}

export function useExplorerController(props: ExplorerBrowserProps, root: FileRootDto) {
  const rootRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const coarsePointer = useCoarsePointer();
  const core = useExplorerCore(props, root, rootRef);
  const { data, selection, dialogs, actions, ops, cutPaths } = core;
  const { listing, entries } = data;

  const commandContext: ExplorerCommandContext = {
    ...core.opsContext,
    ops,
    actions,
    entries,
    selectedEntries: core.selectedEntries,
    cutPaths,
    listingReady: data.listingReady,
    filterInputRef,
    refresh: data.refresh,
  };
  const latest = useLatest(commandContext);
  const commands = useExplorerCommands(latest);
  const openContextMenu = useContextMenuOpener(latest);

  const drop = useExplorerDrop({
    nodeId: core.runtime.nodeId,
    rootId: props.rootId,
    deviceId: root.deviceId,
    path: props.path,
    entries,
    selection: selection.selection,
    actions,
    destNames: ops.destNames,
    onTransfer: props.onTransfer,
    onNavigate: props.onNavigate,
  });

  const canUp = explorerParentPath(props.path, root.path) !== null;
  const { selected } = selection.selection;
  const status = useMemo(
    () => explorerStatus(entries, selected, listing.truncated),
    [entries, selected, listing.truncated]
  );
  useAutoUpOnMissing(core.locationKey, canUp && listing.errorCode === 'not_found', () =>
    props.onUp(root.path)
  );

  return {
    rootRef,
    filterInputRef,
    coarsePointer,
    entries,
    contentKind: contentKindOf({
      loaded: data.listingReady,
      failed: listing.failed,
      total: data.allEntries.length,
      visible: entries.length,
      hasPendingFolder: dialogs.pendingFolder !== null,
    }),
    errorCode: listing.errorCode,
    busy: listing.query.isFetching,
    query: data.query,
    setQuery: data.setQuery,
    selection,
    status,
    cutPaths,
    canUp,
    canPaste: hasPasteSource(commandContext),
    dialogs,
    actions,
    ops,
    commands,
    drop,
    refresh: data.refresh,
    openContextMenu,
  };
}

export type ExplorerController = ReturnType<typeof useExplorerController>;
