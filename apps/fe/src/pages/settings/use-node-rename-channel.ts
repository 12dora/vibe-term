// 「通用」标签里改站点名 = 改本节点名，走的是 hub 控制面（`POST /n/<hub>/api/hub/nodes/:id/rename`）。
// 这里只负责挑出该发给哪台 hub 机，以及这条通道当前是否可用。

import type { HubApi } from '@/node/hub-api';
import { useMeshHubs } from '@/node/mesh-hubs';
import { useHubNode, useMeshNodes } from '@/node/mesh-nodes';
import type { SiteSettingsLinkage } from './site-settings-form';

export interface NodeRenameChannel {
  hubApi: HubApi | null;
  canRenameNode: boolean;
  refreshHub: () => void;
}

/**
 * 联动改名走 entry 的 hub 控制面。非联动（standalone / 老服务端）下这三个 hook 全部空转，
 * 不发任何 `/api/mesh/*` 请求；hub 集合的轮询归节点管理页所有，这里只要一份 hubApi。
 *
 * 目标 hub 必须是**写者**：多 hub 下 mesh 列表里的 `isHub` 会命中任意一台，挑中备 hub 的话
 * rename 会被 `HUB_NOT_WRITER` 拒掉。`/api/mesh/hubs` 的 `writerHubId` 就是当前收写入的那台。
 */
export function useNodeRenameChannel(linkage: SiteSettingsLinkage): NodeRenameChannel {
  const linked = linkage.siteNameLinkedToNode;
  const { nodes } = useMeshNodes({ enabled: linked });
  const hubs = useMeshHubs({ enabled: linked });
  const hub = useHubNode(nodes, {
    enabled: linked,
    hubNodeId: hubs.writerHubId,
    pollIntervalMs: 0,
  });
  return {
    hubApi: hub.hubApi,
    canRenameNode: Boolean(
      linked && linkage.nodeId && hub.hubApi && hub.online && !hubs.writesBlocked
    ),
    refreshHub: hub.refresh,
  };
}
