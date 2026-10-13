// 一个标签页的数据：根目录列表与当前目录列表。查询键与侧栏文件树相同，两边共用缓存、同步刷新。

import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type FileApiError, fetchFileList, fetchFileRoots } from '@vibeterm/api-client';
import type {
  FileEntryDto,
  FileErrorCode,
  FileRootDto,
  ListFileRootsResponse,
  ListFilesResponse,
} from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import { useEffect, useMemo, useRef } from 'react';
import { stabilizeFileEntries } from '../files/file-entry-identity';
import { runCappedFileRootsFetch } from '../files/files-roots-fetch';
import { FILE_ROOTS_QUERY_KEY } from '../files/root-reorder';
import { fileListQueryKey } from '../files/use-directory-listing';

const LIST_STALE_MS = 2000;
const LIST_POLL_MS = 30_000;

const NO_ROOTS: readonly FileRootDto[] = [];

export type ExplorerRootStatus = 'loading' | 'error' | 'missing' | 'ready';

export interface ExplorerRootsResult {
  status: ExplorerRootStatus;
  /** 仅 `ready` 时非空 */
  root: FileRootDto | null;
  /** 可切换的根（已启用） */
  roots: readonly FileRootDto[];
  errorCode?: FileErrorCode;
  retry(): void;
}

function rootStatus(loaded: boolean, failed: boolean, root: FileRootDto | null) {
  if (root) return 'ready' as const;
  if (loaded) return 'missing' as const;
  return failed ? ('error' as const) : ('loading' as const);
}

export function useExplorerRoots(rootId: string, onRootMissing?: () => void): ExplorerRootsResult {
  const { apiClient } = useRuntime();
  const query = useQuery<ListFileRootsResponse, FileApiError>({
    queryKey: FILE_ROOTS_QUERY_KEY,
    queryFn: () => runCappedFileRootsFetch(() => fetchFileRoots(apiClient)),
    refetchOnWindowFocus: false,
  });

  const roots = useMemo(
    () => query.data?.roots.filter((item) => item.enabled) ?? NO_ROOTS,
    [query.data]
  );
  const root = useMemo(() => roots.find((item) => item.id === rootId) ?? null, [roots, rootId]);
  const status = rootStatus(query.data !== undefined, query.isError, root);

  const onMissingRef = useRef(onRootMissing);
  onMissingRef.current = onRootMissing;
  const reportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'missing') {
      reportedFor.current = null;
      return;
    }
    if (reportedFor.current === rootId) return;
    reportedFor.current = rootId;
    onMissingRef.current?.();
  }, [status, rootId]);

  return {
    status,
    root,
    roots,
    errorCode: query.error?.code,
    retry: () => void query.refetch(),
  };
}

export interface ExplorerListing {
  query: UseQueryResult<ListFilesResponse, FileApiError>;
  /** 引用稳定化后的全部条目（未筛选）；还没拿到数据时为 undefined */
  entries: readonly FileEntryDto[] | undefined;
  truncated: boolean;
  /** 没有可显示的数据且请求失败时的错误码 */
  errorCode: FileErrorCode | undefined;
  failed: boolean;
}

export function useExplorerListing(rootId: string, path: string): ExplorerListing {
  const { apiClient } = useRuntime();
  const query = useQuery<ListFilesResponse, FileApiError>({
    queryKey: fileListQueryKey(rootId, path),
    queryFn: () => fetchFileList(rootId, path, apiClient),
    staleTime: LIST_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
    // 首次加载就失败的目录不轮询（等用户点重试）；已有数据的继续轮询，网络恢复后自动跟上
    refetchInterval: (current) =>
      current.state.status === 'error' && current.state.data === undefined ? false : LIST_POLL_MS,
    refetchIntervalInBackground: false,
  });

  // 轮询会让插入 / 删除点之后的 entry 全部换新对象；按路径复用上一份，保住行级 memo
  const entriesRef = useRef<readonly FileEntryDto[] | undefined>(undefined);
  const fetched = query.data?.entries;
  const entries = fetched ? stabilizeFileEntries(entriesRef.current, fetched) : undefined;
  if (entries) entriesRef.current = entries;

  return {
    query,
    entries,
    truncated: query.data?.truncated ?? false,
    errorCode: query.error?.code,
    failed: query.isError,
  };
}
