// 本机运行态（角色 / hub 地址 / 直连插件 / TLS）。
//
// mesh 下 `GET /api/local/status` 需要 self 会话，未登录返回 401——这里把 401 单独摘出来，
// 由调用方渲染「请先登录」提示，而不是当成加载失败或直接崩掉。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type LocalApi, LocalApiError, defaultLocalApi } from '@tmex/api-client/local/local-api';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { useCallback } from 'react';

export const LOCAL_STATUS_QUERY_KEY = ['local-status'] as const;

export interface LocalStatusState {
  status: LocalStatusResponse | null;
  loading: boolean;
  /** mesh 下未登录：给登录提示，不报错。 */
  loginRequired: boolean;
  error: string | null;
  refresh: () => void;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof LocalApiError && error.status === 401;
}

export function useLocalStatus(api: LocalApi = defaultLocalApi): LocalStatusState {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: LOCAL_STATUS_QUERY_KEY,
    queryFn: () => api.status(),
    // 401 不重试：重试只会多刷几次登录拦截器。
    retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: LOCAL_STATUS_QUERY_KEY });
  }, [queryClient]);

  const loginRequired = isUnauthorized(query.error);
  return {
    status: query.data ?? null,
    loading: query.isPending,
    loginRequired,
    error:
      !query.error || loginRequired
        ? null
        : query.error instanceof Error
          ? query.error.message
          : String(query.error),
    refresh,
  };
}
