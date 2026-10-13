// 每个节点有几台设备——节点磁贴网格据此决定磁贴占几列（跨度 = min(设备数, 列数)）。
//
// 不为此多发任何请求，数字只来自页面本来就有的三处：
//   - 权威值：该节点面板每次成功拿到真实列表时经 `onDevicesLoaded` 报上来的长度；
//   - 估计值：还没有权威值时用本地离线快照（没有快照退回节点 inventory）的长度，首帧就能
//     摆对宽度，不必等列表回来再把整行重排一遍；
//   - 都没有按一台算。
// 估计值在一次挂载里只增不减（快照读一次，之后只看 inventory 有没有变多），免得磁贴来回
// 伸缩；只有权威值才会把磁贴改窄。

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type DeviceSnapshotStorage,
  inventoryFallbackDevices,
  offlineDevices,
} from './device-snapshot-store';

export interface NodeDeviceCountSource {
  runtimeNodeId: string;
  inventory: unknown;
}

/** 首次见到这个节点时的估计：离线快照优先，其次 inventory，至少一台 */
export function seedNodeDeviceCount(
  node: NodeDeviceCountSource,
  storage?: DeviceSnapshotStorage | null
): number {
  return Math.max(1, offlineDevices(node.runtimeNodeId, node.inventory, storage).length);
}

/**
 * 节点列表变化后的新一份估计值：新节点读快照；见过的节点只跟 inventory 比大（不再读存储），
 * 已经不在列表里的节点丢掉。
 */
export function nextNodeDeviceSeeds(
  prev: ReadonlyMap<string, number>,
  nodes: readonly NodeDeviceCountSource[],
  storage?: DeviceSnapshotStorage | null
): Map<string, number> {
  const next = new Map<string, number>();
  for (const node of nodes) {
    const known = prev.get(node.runtimeNodeId);
    next.set(
      node.runtimeNodeId,
      known === undefined
        ? seedNodeDeviceCount(node, storage)
        : Math.max(known, inventoryFallbackDevices(node.inventory).length)
    );
  }
  return next;
}

/** 权威值优先（可以比估计值小），否则用估计值；至少一台 */
export function resolveNodeDeviceCount(live: number | undefined, seed: number | undefined): number {
  return Math.max(1, live ?? seed ?? 1);
}

export interface NodeDeviceCounts {
  countOf: (nodeId: string) => number;
  /** 面板拿到真实设备列表时调用；引用稳定，可以直接当 effect 依赖 */
  report: (nodeId: string, count: number) => void;
}

export function useNodeDeviceCounts(nodes: readonly NodeDeviceCountSource[]): NodeDeviceCounts {
  const [live, setLive] = useState<Record<string, number>>({});
  const seedsRef = useRef<ReadonlyMap<string, number>>(new Map());
  // 在渲染期就算好（而不是 effect 里）：首帧的磁贴宽度就要用到。写 ref 是幂等的（只增不减）
  const seeds = useMemo(() => {
    const next = nextNodeDeviceSeeds(seedsRef.current, nodes);
    seedsRef.current = next;
    return next;
  }, [nodes]);

  const report = useCallback((nodeId: string, count: number) => {
    setLive((prev) => (prev[nodeId] === count ? prev : { ...prev, [nodeId]: count }));
  }, []);
  const countOf = useCallback(
    (nodeId: string) => resolveNodeDeviceCount(live[nodeId], seeds.get(nodeId)),
    [live, seeds]
  );
  return { countOf, report };
}
