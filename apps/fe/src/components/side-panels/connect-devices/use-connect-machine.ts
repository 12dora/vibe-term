// 指引要用的本机现状：角色（`/api/local/status`）、中继链路（`/api/mesh/relay/status`）
// 与 `/api/auth/mode` 折成一份扁平快照，三条路径共用。
//
// `/api/local/status` 在旧节点上是 404、未登录时是 401：两者对指引都只是「拿不到现状」，
// 页面退回纯静态文案即可，所以这里用自己的查询键把它们映射成 null——既不重试、不产生
// 错误态，也不会把这份「允许缺失」的口径写进设置页共用的那份缓存。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import { LOCAL_STATUS_QUERY_KEY } from '@/pages/settings/status-queries';
import { useQuery } from '@tanstack/react-query';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { type LocalApi, LocalApiError, defaultLocalApi } from '@tmex/api-client/local/local-api';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import type { ConnectStatus } from './connect-path';

/** 指引专用的查询键：口径与设置页不同，不能共用同一份缓存。 */
export const GUIDE_LOCAL_STATUS_QUERY_KEY = [...LOCAL_STATUS_QUERY_KEY, 'guide'] as const;

/** 未登录（401）与旧节点没有这条路由（404）：都按「没有本机现状」处理。 */
export function isLocalStatusMissing(error: unknown): boolean {
  return error instanceof LocalApiError && (error.status === 401 || error.status === 404);
}

function useGuideLocalStatus(api: LocalApi): LocalStatusResponse | null {
  const query = useQuery({
    queryKey: GUIDE_LOCAL_STATUS_QUERY_KEY,
    queryFn: async () => {
      try {
        return await api.status();
      } catch (err) {
        if (isLocalStatusMissing(err)) return null;
        throw err;
      }
    },
    staleTime: 10_000,
    retry: 1,
  });
  return query.data ?? null;
}

export interface ConnectMachine extends ConnectStatus {
  mode: AuthModeResponse | null;
  /** 新机器该加入的中继地址：本机挂着的那条，本机自己就是中继时用它的对外地址。 */
  relayUrl: string | null;
  /** 新机器该加入的 Hub 地址；中继模式下没有 Hub。 */
  hubUrl: string | null;
  /** 本机自己作为中继时的对外地址。 */
  relayPublicUrl: string | null;
  /** 本机作为中继时是否已设接入密码。 */
  relayHasPassword: boolean;
}

export function useConnectMachine(api: LocalApi = defaultLocalApi): ConnectMachine {
  const { mode, meshEnabled } = useSharedAuthMode();
  const relay = useMeshRelay({ enabled: meshEnabled });
  const status = useGuideLocalStatus(api);
  const attached = relay.attached ?? relay.ordered[0] ?? null;

  return {
    role: status?.role ?? null,
    relayAttached: relay.attached !== null,
    relayMode: relay.relayMode,
    meshEnabled,
    mode,
    relayUrl: attached?.url ?? status?.relay?.publicUrl ?? null,
    tenantId: relay.relayMode ? relay.tenantId : null,
    hubUrl: mode?.mode === 'mesh' && !relay.relayMode ? (mode.hubPublicUrl ?? null) : null,
    relayPublicUrl: status?.relay?.publicUrl ?? null,
    relayHasPassword: status?.relay?.hasPassword ?? false,
  };
}
