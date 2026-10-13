// 文件管理器用的节点目录：与传输弹窗同一套「运行时 id + 真实 mesh id + 可用性」选项，
// 另带一个「成员表是否到齐」的信号——宿主据此才敢清理指向不存在节点的标签页。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { toRuntimeNodeId, useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type DialogNodeOption,
  findDialogNode,
  toDialogNodeOptions,
} from '../devices/dialog-nodes';

export interface ExplorerNodes {
  options: DialogNodeOption[];
  /** 成员表完整可信；为 false 时不要据此判定「节点已不存在」。 */
  ready: boolean;
  find(nodeId: string): DialogNodeOption | undefined;
  /**
   * 全部现有成员的运行时 id（entry 为 `self`），**含已暂停 / 离线的**；仅在 `ready` 时可信。
   * 清理标签页要按它判，不能按 `options`：暂停的节点不在选项里，但它并没有消失。
   */
  memberIds: ReadonlySet<string>;
}

export type ExplorerNodeState = 'ready' | 'offline' | 'signedOut' | 'paused' | 'missing';

/** 标签页该显示哪种状态：不在选项里的成员即被暂停（界面上按离线处理），连成员都不是才算不存在。 */
export function explorerNodeState(
  node: DialogNodeOption | undefined,
  isMember: boolean
): ExplorerNodeState {
  if (!node) return isMember ? 'paused' : 'missing';
  if (!node.online) return 'offline';
  if (!node.loggedIn) return 'signedOut';
  return 'ready';
}

export interface ExplorerNodesInput {
  /** `/api/auth/mode` 是否已经回来；没回来时 `meshEnabled` 只是缺省的 false。 */
  modeLoaded: boolean;
  meshEnabled: boolean;
  entryNodeId: string | null;
  nodes: MeshNode[];
  selfName: string;
  inventoryReady: boolean;
  inventoryLoading: boolean;
}

export function explorerNodeOptions(
  input: ExplorerNodesInput
): Pick<ExplorerNodes, 'options' | 'ready' | 'memberIds'> {
  if (!input.meshEnabled) {
    // 模式未知时先只给本机，但不报 ready：否则远端标签页会在 mesh 模式确认前被清掉。
    // 确认是 standalone 之后 meshId 固定为 `self`：没有 mesh 桥，同节点传输任务两端都报 `self`
    // （standalone 下 `/api/auth/mode` 仍可能带回本机的 node id，不能拿它当对端 id）。
    const entryNodeId = input.modeLoaded ? null : input.entryNodeId;
    return {
      options: toDialogNodeOptions([], entryNodeId, input.selfName),
      ready: input.modeLoaded,
      memberIds: new Set([SELF_NODE_ID]),
    };
  }
  // entry 自己永远是成员，哪怕列表暂时是空的
  const memberIds = new Set([SELF_NODE_ID]);
  for (const node of input.nodes) memberIds.add(toRuntimeNodeId(node.id, input.entryNodeId));
  return {
    options: toDialogNodeOptions(input.nodes, input.entryNodeId, input.selfName, {
      loading: input.inventoryLoading,
    }),
    ready: input.inventoryReady,
    memberIds,
  };
}

export function useExplorerNodes(): ExplorerNodes {
  const { t } = useTranslation();
  const { meshEnabled, entryNodeId, loaded } = useSharedAuthMode();
  const { nodes } = useMeshNodes({ enabled: meshEnabled });
  const readiness = useInventoryReadiness();
  const selfName = t('device.addTo.self');

  const { options, ready, memberIds } = useMemo(
    () =>
      explorerNodeOptions({
        modeLoaded: loaded,
        meshEnabled,
        entryNodeId,
        nodes,
        selfName,
        inventoryReady: readiness.ready,
        inventoryLoading: readiness.loading,
      }),
    [loaded, meshEnabled, entryNodeId, nodes, selfName, readiness.ready, readiness.loading]
  );
  const find = useCallback((nodeId: string) => findDialogNode(options, nodeId), [options]);

  return useMemo(() => ({ options, ready, find, memberIds }), [options, ready, find, memberIds]);
}
