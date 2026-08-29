// 内置 HTTPS 状态（模式 / 监听 / 证书 / ACME 状态机）。
//
// ACME 签发是后台任务：`PUT /api/tls` 立刻返回 `acme.status === 'pending'`，真正的成败要靠
// 轮询 `GET /api/tls` 才能看到，所以 pending 期间自动每 3 秒拉一次，其余时间不轮询。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type TlsApi, TlsApiError, defaultTlsApi } from '@tmex/api-client/local/tls-api';
import type { TlsStatusResponse } from '@tmex/api-client/local/tls-types';
import { useCallback } from 'react';

export const TLS_STATUS_QUERY_KEY = ['tls-status'] as const;
export const ACME_POLL_INTERVAL_MS = 3000;

export interface TlsStatusState {
  status: TlsStatusResponse | null;
  loading: boolean;
  /** mesh 下未登录：给登录提示，不报错。 */
  loginRequired: boolean;
  error: string | null;
  refresh: () => void;
  /** 变更接口的响应体就是 `GET /api/tls` 的形状，直接写缓存省一次往返。 */
  setStatus: (next: TlsStatusResponse) => void;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof TlsApiError && error.status === 401;
}

export function useTlsStatus(
  api: TlsApi = defaultTlsApi,
  options: { enabled?: boolean } = {}
): TlsStatusState {
  // 纯 node 角色下整块 HTTPS 都是灰的，连状态都不该去问（mesh 下这一发还要带上会话）。
  const enabled = options.enabled ?? true;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: TLS_STATUS_QUERY_KEY,
    queryFn: () => api.status(),
    enabled,
    // 401 不重试：重试只会多刷几次登录拦截器。
    retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
    refetchInterval: (q) =>
      q.state.data?.acme?.status === 'pending' ? ACME_POLL_INTERVAL_MS : false,
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: TLS_STATUS_QUERY_KEY });
  }, [queryClient]);

  const setStatus = useCallback(
    (next: TlsStatusResponse) => {
      queryClient.setQueryData(TLS_STATUS_QUERY_KEY, next);
    },
    [queryClient]
  );

  const loginRequired = isUnauthorized(query.error);
  return {
    status: query.data ?? null,
    // 关掉查询时 react-query 也报 pending，但这时不该转圈。
    loading: enabled && query.isPending,
    loginRequired,
    error:
      !query.error || loginRequired
        ? null
        : query.error instanceof Error
          ? query.error.message
          : String(query.error),
    refresh,
    setStatus,
  };
}
