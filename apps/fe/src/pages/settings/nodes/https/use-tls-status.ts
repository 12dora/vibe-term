// 内置 HTTPS 状态（模式 / 监听 / 证书 / ACME 状态机）。
//
// ACME 签发是后台任务：`PUT /api/tls` 立刻返回 `acme.status === 'pending'`，真正的成败要靠
// 轮询 `GET /api/tls` 才能看到，所以 pending 期间自动每 3 秒拉一次，其余时间不轮询。

import { type TlsApi, TlsApiError, defaultTlsApi } from '@tmex/api-client/local/tls-api';
import type { TlsStatusResponse } from '@tmex/api-client/local/tls-types';
import { useProtectedStatusQuery } from '../../use-protected-status-query';
import { acmePollInterval } from './tls-form';

export const TLS_STATUS_QUERY_KEY = ['tls-status'] as const;
export { ACME_POLL_INTERVAL_MS } from './tls-form';

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
  return useProtectedStatusQuery<TlsStatusResponse>({
    queryKey: TLS_STATUS_QUERY_KEY,
    queryFn: () => api.status(),
    isUnauthorized,
    enabled: options.enabled,
    refetchInterval: acmePollInterval,
  });
}
