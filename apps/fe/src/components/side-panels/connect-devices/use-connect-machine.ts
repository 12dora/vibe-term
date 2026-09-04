// 指引要用的本机现状：角色（`/api/local/status`）、中继链路（`/api/mesh/relay/status`）
// 与 `/api/auth/mode` 折成一份扁平快照，三条路径共用。
//
// `/api/local/status` 在旧节点上是 404、未登录时是 401：`useLocalStatus` 已把两者摘干净，
// 这里只需按「拿不到」处理，指引退回纯静态文案。

import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import { useLocalStatus } from '@/pages/settings/nodes/use-local-status';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import type { ConnectStatus } from './connect-path';

export interface ConnectMachine extends ConnectStatus {
  mode: AuthModeResponse | null;
  /** 新机器该加入的中继地址：本机挂着的那条，本机自己就是中继时用它的对外地址。 */
  relayUrl: string | null;
  /** 本机所在的租户；本机不是中继租户时为 null。 */
  tenantId: string | null;
  /** 新机器该加入的 Hub 地址；中继模式下没有 Hub。 */
  hubUrl: string | null;
  /** 本机自己作为中继时的对外地址。 */
  relayPublicUrl: string | null;
  /** 本机作为中继时是否已设接入密码。 */
  relayHasPassword: boolean;
}

export function useConnectMachine(): ConnectMachine {
  const { mode, meshEnabled } = useSharedAuthMode();
  const relay = useMeshRelay({ enabled: meshEnabled });
  const local = useLocalStatus();
  const status = local.status;
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
