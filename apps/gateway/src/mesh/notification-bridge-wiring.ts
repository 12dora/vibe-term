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
  listedNodes: () => ReadonlyArray<{ id: string; name: string }>;
  /** 用户签过 `notification-sink` 声明的节点集合（从密钥日志回放，见 notification-sink-records）。 */
  declaredSinks: () => ReadonlySet<string>;
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
  const declared = () => input.declaredSinks();
  // 不走 `this`：桥的方法可能被解构后单独传出去（转发器就只拿 deliver）。
  const authorized = (nodeId: string): boolean =>
    nodeId !== input.selfNodeId && declared().has(nodeId);
  return {
    selfNodeId: () => input.selfNodeId,
    selfName: () => input.selfName(),
    /** 本机收不收转发件：用户签过的声明 + 本机开关，缺一不可。 */
    selfSinkEnabled(): boolean {
      return isMeshNotificationSinkEnabled() && declared().has(input.selfNodeId);
    },
    sinkAuthorized: authorized,
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
    /**
     * 投递前最后一道闸：声明已被撤销就地回 403，不出网。
     * 队列侧也会查一次（`isSinkAuthorized`），这里保证任何调用方都绕不过去。
     */
    deliver(
      sinkNodeId: string,
      body: MeshNotificationForwardRequest,
      signal?: AbortSignal
    ): Promise<Response> {
      if (!authorized(sinkNodeId)) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return input.forwardInternalHttp(sinkNodeId, MESH_INTERNAL_NOTIFICATION_ROUTE, body, signal);
    },
  };
}
