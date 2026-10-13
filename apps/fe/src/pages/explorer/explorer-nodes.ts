// 文件管理器用的节点目录：与传输弹窗同一套「运行时 id + 真实 mesh id + 可用性」选项，
// 另带一个「成员表是否到齐」的信号——宿主据此才敢清理指向不存在节点的标签页。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
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
): Pick<ExplorerNodes, 'options' | 'ready'> {
  if (!input.meshEnabled) {
    // 模式未知时先只给本机，但不报 ready：否则远端标签页会在 mesh 模式确认前被清掉
    return {
      options: toDialogNodeOptions([], input.entryNodeId, input.selfName),
      ready: input.modeLoaded,
    };
  }
  return {
    options: toDialogNodeOptions(input.nodes, input.entryNodeId, input.selfName, {
      loading: input.inventoryLoading,
    }),
    ready: input.inventoryReady,
  };
}

export function useExplorerNodes(): ExplorerNodes {
  const { t } = useTranslation();
  const { meshEnabled, entryNodeId, loaded } = useSharedAuthMode();
  const { nodes } = useMeshNodes({ enabled: meshEnabled });
  const readiness = useInventoryReadiness();
  const selfName = t('device.addTo.self');

  const { options, ready } = useMemo(
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

  return useMemo(() => ({ options, ready, find }), [options, ready, find]);
}
