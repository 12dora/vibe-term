import { useQuery } from '@tanstack/react-query';
import { type ApiClient, fetchFileStat } from '@vibeterm/api-client';
import type { FileRef } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';

/** stat 查询的键与取数：预览页、顶栏动作与邻居预取共用，同键即同一份缓存。 */
export function fileStatQueryOptions(rootId: string, path: string, apiClient: ApiClient) {
  return {
    queryKey: ['files', 'stat', rootId, path] as const,
    queryFn: () => fetchFileStat(rootId, path, apiClient),
    retry: false,
    refetchOnWindowFocus: false,
  };
}

export function useFileStat(fileRef: FileRef | null) {
  const { apiClient } = useRuntime();
  return useQuery({
    ...fileStatQueryOptions(fileRef?.rootId ?? '', fileRef?.path ?? '', apiClient),
    enabled: Boolean(fileRef),
  });
}
