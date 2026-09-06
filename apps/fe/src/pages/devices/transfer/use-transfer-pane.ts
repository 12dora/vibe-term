// 面板的数据与键盘逻辑：两组查询 + 条目整理 + 高亮跟焦点。组件只管渲染。

import { useQuery } from '@tanstack/react-query';
import { createNodeApiClient } from '@tmex/api-client';
import type { FileEntryDto, FileRootDto } from '@tmex/shared';
import { type Dispatch, type KeyboardEvent, useEffect, useMemo, useRef } from 'react';

import {
  type TransferPaneAction,
  type TransferPaneState,
  isDirectoryEntry,
  parentPath,
  visibleEntries,
} from './pane-state';
import { fileListQueryOptions, fileRootsQueryOptions } from './transfer-queries';

/** nodeId 还没选时查询本就 disabled，用一个固定实例占位即可（不会发出请求）。 */
const IDLE_CLIENT = createNodeApiClient(null);

export interface TransferPaneModel {
  roots: FileRootDto[];
  entries: FileEntryDto[];
  paths: string[];
  currentPath: string;
  parent: string | null;
  listPending: boolean;
  listError: boolean;
  rowRefs: { current: Array<HTMLButtonElement | null> };
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
}

export function useTransferPane(
  state: TransferPaneState,
  dispatch: Dispatch<TransferPaneAction>
): TransferPaneModel {
  const client = useMemo(
    () => (state.nodeId ? createNodeApiClient(state.nodeId) : null),
    [state.nodeId]
  );

  const rootsQuery = useQuery({
    ...fileRootsQueryOptions(state.nodeId ?? '', client ?? IDLE_CLIENT),
    enabled: client !== null,
    retry: false,
  });
  const roots = useMemo(
    () => (rootsQuery.data?.roots ?? []).filter((root) => root.enabled),
    [rootsQuery.data]
  );

  // 根目录只在没选过时自动落到第一个：用户手动切走之后不再被查询回填覆盖。
  useEffect(() => {
    if (state.rootId !== null || roots.length === 0) return;
    dispatch({ type: 'selectRoot', rootId: roots[0].id });
  }, [dispatch, roots, state.rootId]);

  const listQuery = useQuery({
    ...fileListQueryOptions(
      state.nodeId ?? '',
      state.rootId ?? '',
      state.path,
      client ?? IDLE_CLIENT
    ),
    enabled: client !== null && state.rootId !== null,
    retry: false,
  });

  const resolvedPath = listQuery.data?.path;
  useEffect(() => {
    if (resolvedPath) dispatch({ type: 'sync', path: resolvedPath });
  }, [dispatch, resolvedPath]);

  const entries = useMemo(
    () => visibleEntries(listQuery.data?.entries ?? [], state.hidden),
    [listQuery.data, state.hidden]
  );
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);

  useEffect(() => {
    dispatch({ type: 'prune', paths });
  }, [dispatch, paths]);

  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  rowRefs.current.length = entries.length;
  useEffect(() => {
    if (state.highlight >= 0) rowRefs.current[state.highlight]?.focus();
  }, [state.highlight]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // 路径输入框里的上下键留给光标
      if (target.tagName === 'INPUT') return;
      event.preventDefault();
      dispatch({ type: 'move', delta: event.key === 'ArrowDown' ? 1 : -1, count: entries.length });
      return;
    }
    const highlighted = state.highlight >= 0 ? entries[state.highlight] : undefined;
    if (event.key === 'Enter' && highlighted && target.closest('[data-picker-index]')) {
      event.preventDefault();
      if (isDirectoryEntry(highlighted)) dispatch({ type: 'navigate', path: highlighted.path });
    }
  };

  const currentPath = resolvedPath ?? state.path;

  return {
    roots,
    entries,
    paths,
    currentPath,
    parent: parentPath(currentPath),
    listPending: listQuery.isPending && state.rootId !== null,
    listError: listQuery.isError,
    rowRefs,
    onKeyDown,
  };
}
