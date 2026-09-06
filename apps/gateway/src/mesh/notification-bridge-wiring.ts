// 把 mesh 装配根里的零件组装成 `MeshNotificationBridge`，避免 mesh-runtime 继续膨胀。

import type { MeshNotificationForwardRequest, MeshNotificationSink } from '@tmex/shared';
import { MESH_INTERNAL_NOTIFICATION_ROUTE } from '@tmex/shared';
import type { UserStore } from '../auth/user-store';
import type { MeshNotificationBridge } from './notification-mesh-bridge';
import { collectMeshNotificationSinks } from './notification-sink-set';
import { isMeshNotificationSinkEnabled } from './notification-sink-state';
import type { PeerReach } from './types';

export type MeshNotificationBridgeInput = {
  selfNodeId: string;
  selfName: () => string | null;
  userStore: UserStore;
  listReach: () => ReadonlyMap<string, PeerReach>;
  listHubOnline: () => ReadonlySet<string>;
  listedNodes: () => ReadonlyArray<{ id: string; name: string; inventory?: unknown }>;
  forwardInternalHttp: (
    nodeId: string,
    path: string,
    body: unknown,
    signal?: AbortSignal
  ) => Promise<Response>;
  advertise: () => void;
};

export function buildMeshNotificationBridge(
  input: MeshNotificationBridgeInput
): MeshNotificationBridge {
  return {
    selfNodeId: () => input.selfNodeId,
    selfName: () => input.selfName(),
    listSinks(): MeshNotificationSink[] {
      return collectMeshNotificationSinks({
        selfNodeId: input.selfNodeId,
        selfName: input.selfName(),
        selfEnabled: isMeshNotificationSinkEnabled(),
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
    advertise: () => input.advertise(),
  };
}
