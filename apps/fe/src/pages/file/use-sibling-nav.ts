// 预览页的同目录兄弟导航：列表与文件管理器共用查询键（通常已是热缓存），顺序取文件管理器的工作区设置。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchFileList } from '@vibeterm/api-client';
import type { FileCategory, FileEntryDto } from '@vibeterm/shared';
import { dirname } from '@vibeterm/shared';
import { type FileRef, fileRoute, hostAppPath } from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/explorer';
import { useRuntime } from '@vibeterm/stores/react';
import { useCallback, useEffect, useMemo } from 'react';
import { arrowKeyDirection } from './arrow-keys';
import { pickSiblings } from './siblings';
import { fileStatQueryOptions } from './use-file-stat';

// 与文件管理器列表同一个过期窗口，免得两边互相触发重取。
const LIST_STALE_MS = 2000;
// 邻居 stat 的预取保鲜期：切过去时直接用缓存，页面随后照常后台刷新。
const PREFETCH_STALE_MS = 30_000;

export interface SiblingNav {
  prev: FileEntryDto | null;
  next: FileEntryDto | null;
  /** 列表里当前文件的类别；stat 回来之前预览页先靠它决定按钮与方向键 */
  category: FileCategory | null;
  goPrev(): void;
  goNext(): void;
}

export function useSiblingNav(fileRef: FileRef | null): SiblingNav {
  const { apiClient, host } = useRuntime();
  const queryClient = useQueryClient();
  const sort = useExplorerStore((state) => state.sort);
  const showHidden = useExplorerStore((state) => state.showHidden);
  const rootId = fileRef?.rootId ?? '';
  const path = fileRef?.path ?? '';
  const dir = dirname(path);

  const listing = useQuery({
    queryKey: ['files', 'list', rootId, dir],
    queryFn: () => fetchFileList(rootId, dir, apiClient),
    enabled: Boolean(fileRef),
    staleTime: LIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const entries = listing.data?.entries;
  const siblings = useMemo(
    () => (entries && fileRef ? pickSiblings(entries, path, { sort, showHidden }) : null),
    [entries, fileRef, path, sort, showHidden]
  );
  const prev = siblings?.prev ?? null;
  const next = siblings?.next ?? null;

  // 预取两侧邻居的 stat：切换时不必等一次往返，也不会闪「加载中」
  useEffect(() => {
    for (const entry of [prev, next]) {
      if (!entry) continue;
      void queryClient.prefetchQuery({
        ...fileStatQueryOptions(rootId, entry.path, apiClient),
        staleTime: PREFETCH_STALE_MS,
      });
    }
  }, [prev, next, rootId, apiClient, queryClient]);

  // replace：返回键应回到文件管理器，而不是一张张倒着翻过来
  const open = useCallback(
    (entry: FileEntryDto | null) => {
      if (entry) host.navigate(hostAppPath(host, fileRoute(rootId, entry.path)), { replace: true });
    },
    [host, rootId]
  );
  return {
    prev,
    next,
    category: siblings?.current.category ?? null,
    goPrev: useCallback(() => open(prev), [open, prev]),
    goNext: useCallback(() => open(next), [open, next]),
  };
}

/** 图片 / PDF / 音视频预览的方向键切换；文本类预览不监听。 */
export function useSiblingArrowKeys(nav: SiblingNav, category: FileCategory | null): void {
  const { prev, next, goPrev, goNext } = nav;
  useEffect(() => {
    if (category === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const direction = arrowKeyDirection(event, category);
      if (direction === null || !(direction === 'prev' ? prev : next)) return;
      event.preventDefault();
      if (direction === 'prev') goPrev();
      else goNext();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [category, prev, next, goPrev, goNext]);
}
