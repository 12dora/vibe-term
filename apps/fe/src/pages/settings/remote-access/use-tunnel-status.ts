// 远程访问状态查询。
//
// 安装 / 登录 / 创建都是后台 job：`POST /api/tunnel/actions` 只返回受理时的快照，成败要靠
// 轮询 `GET /api/tunnel/status` 才看得到，因此 job 在跑或进程正在起来时 2 秒一拉，其余 10 秒。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { TunnelApiError, fetchTunnelStatus } from '@tmex/api-client/local/tunnel-api';
import type { TunnelStatusResponse } from '@tmex/shared';
import { TUNNEL_STATUS_QUERY_KEY } from '../status-queries';
import { useProtectedStatusQuery } from '../use-protected-status-query';
import { tunnelPollInterval } from './tunnel-model';

// 查询键与悬停预取共用一份定义（见 status-queries.ts），键抄错就会写进两份缓存。
export { TUNNEL_STATUS_QUERY_KEY };

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
  const client = options.client ?? defaultApiClient;
  return useProtectedStatusQuery<TunnelStatusResponse>({
    queryKey: TUNNEL_STATUS_QUERY_KEY,
    queryFn: () => fetchTunnelStatus(client),
    isUnauthorized,
    enabled: options.enabled,
    refetchInterval: tunnelPollInterval,
  });
}
