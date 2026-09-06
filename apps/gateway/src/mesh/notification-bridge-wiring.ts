// 把 mesh 装配根里的零件组装成 `MeshNotificationBridge`，避免 mesh-runtime 继续膨胀。

import type { MeshNotificationForwardRequest, MeshNotificationSink } from '@tmex/shared';
import { MESH_INTERNAL_NOTIFICATION_ROUTE } from '@tmex/shared';
import type { UserStore } from '../auth/user-store';
import type { MeshNotificationBridge } from './notification-mesh-bridge';
import { listNotificationSinkNodeIds } from './notification-sink-records';
import { collectMeshNotificationSinks } from './notification-sink-set';
import { isMeshNotificationSinkEnabled } from './notification-sink-state';
import type { PeerReach } from './types';

export type MeshNotificationBridgeInput = {
  selfNodeId: string;
  selfName: () => string | null;
  userStore: UserStore;
  listReach: () => ReadonlyMap<string, PeerReach>;
  listHubOnline: () => ReadonlySet<string>;
  listedNodes: () => ReadonlyArray<{ id: string; name: string }>;
  /** 当前用户编号；汇聚声明从这名用户的密钥日志里回放。 */
  userIdOf: () => string;
  forwardInternalHttp: (
    nodeId: string,
    path: string,
    body: unknown,
    signal?: AbortSignal
  ) => Promise<Response>;
};

export function buildMeshNotificationBridge(
  input: MeshNotificationBridgeInput
): MeshNotificationBridge {
  const declared = () => listNotificationSinkNodeIds(input.userIdOf());
  return {
    selfNodeId: () => input.selfNodeId,
    selfName: () => input.selfName(),
    /** 本机收不收转发件：用户签过的声明 + 本机开关，缺一不可。 */
    selfSinkEnabled(): boolean {
      return isMeshNotificationSinkEnabled() && declared().has(input.selfNodeId);
    },
    listSinks(): MeshNotificationSink[] {
      return collectMeshNotificationSinks({
        selfNodeId: input.selfNodeId,
        selfName: input.selfName(),
        selfEnabled: isMeshNotificationSinkEnabled(),
        declared: declared(),
        listed: input.listedNodes(),
        certs: input.userStore.listCerts(),
        peers: input.userStore.listPeers(),
        nodes: input.userStore.listNodes(),
        reach: input.listReach(),
        hubOnline: input.listHubOnline(),
      });
    },
    deliver(
      sinkNodeId: string,
      body: MeshNotificationForwardRequest,
      signal?: AbortSignal
    ): Promise<Response> {
      return input.forwardInternalHttp(sinkNodeId, MESH_INTERNAL_NOTIFICATION_ROUTE, body, signal);
    },
  };
}
