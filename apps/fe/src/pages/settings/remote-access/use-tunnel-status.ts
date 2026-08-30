// 远程访问状态查询。
//
// 安装 / 登录 / 创建都是后台 job：`POST /api/tunnel/actions` 只返回受理时的快照，成败要靠
// 轮询 `GET /api/tunnel/status` 才看得到，因此 job 在跑或进程正在起来时 2 秒一拉，其余 10 秒。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { TunnelApiError, fetchTunnelStatus } from '@tmex/api-client/local/tunnel-api';
import type { TunnelStatusResponse } from '@tmex/shared';
import { useCallback } from 'react';
import { tunnelPollInterval } from './tunnel-model';

export const TUNNEL_STATUS_QUERY_KEY = ['tunnel-status'] as const;

export interface TunnelStatusState {
  status: TunnelStatusResponse | null;
  loading: boolean;
  /** mesh 下未登录：给登录提示，不报错。 */
  loginRequired: boolean;
  error: string | null;
  refresh: () => void;
  /** 动作接口的响应体里就带着新快照，直接写缓存省一次往返。 */
  setStatus: (next: TunnelStatusResponse) => void;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof TunnelApiError && error.status === 401;
}

export interface UseTunnelStatusOptions {
  enabled?: boolean;
  client?: ApiClient;
}

export function useTunnelStatus(options: UseTunnelStatusOptions = {}): TunnelStatusState {
  const enabled = options.enabled ?? true;
  const client = options.client ?? defaultApiClient;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: TUNNEL_STATUS_QUERY_KEY,
    queryFn: () => fetchTunnelStatus(client),
    enabled,
    // 401 不重试：重试只会多刷几次登录拦截器。
    retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
    refetchInterval: (q) => tunnelPollInterval(q.state.data),
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: TUNNEL_STATUS_QUERY_KEY });
  }, [queryClient]);

  const setStatus = useCallback(
    (next: TunnelStatusResponse) => {
      queryClient.setQueryData(TUNNEL_STATUS_QUERY_KEY, next);
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
