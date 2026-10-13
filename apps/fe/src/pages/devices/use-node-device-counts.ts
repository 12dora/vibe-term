// 每个节点有几台设备——节点磁贴网格据此决定磁贴占几列（跨度 = min(设备数, 列数)）。
//
// 不为此多发任何请求，数字只来自页面本来就有的地方，而且与面板实际画出来的卡片是同一条规则：
//   - 面板拿到过真实列表：用它的长度（每次变化都会经 `onDevicesLoaded` 报上来）；
//   - 否则用面板离线时会画的那份——本地快照**有就用快照**，没有才用节点 inventory
//     （与 `offlineDevices` 一致，两者不合并、不取大）。首帧就能摆对宽度；
//   - 都没有按一台算。
// 快照只在真实列表到达时才会被改写（那时权威值也同时到了），所以每个节点一次挂载只读一次存储，
// 之后节点列表再怎么刷新都只看 inventory。

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type DeviceSnapshotStorage,
  inventoryFallbackDevices,
  readDeviceSnapshot,
} from './device-snapshot-store';

export interface NodeDeviceCountSource {
  runtimeNodeId: string;
  inventory: unknown;
}

/** 节点的离线快照里有几台设备；没有快照返回 null（空快照是 0，不是 null） */
export function readSnapshotCount(
  runtimeNodeId: string,
  storage?: DeviceSnapshotStorage | null
): number | null {
  return readDeviceSnapshot(runtimeNodeId, storage)?.length ?? null;
}

/**
 * 节点列表变化后的快照台数表：新节点读一次存储，见过的节点沿用（不再读），已经不在列表里的
 * 节点丢掉。
 */
export function nextSnapshotCounts(
  prev: ReadonlyMap<string, number | null>,
  nodes: readonly NodeDeviceCountSource[],
  storage?: DeviceSnapshotStorage | null
): Map<string, number | null> {
  const next = new Map<string, number | null>();
  for (const node of nodes) {
    const known = prev.get(node.runtimeNodeId);
    next.set(
      node.runtimeNodeId,
      known === undefined ? readSnapshotCount(node.runtimeNodeId, storage) : known
    );
  }
  return next;
}

/** 没有真实列表时的估计，与离线面板画的卡片数一致：有快照用快照，否则用 inventory */
export function estimateNodeDeviceCount(
  snapshotCount: number | null | undefined,
  inventory: unknown
): number {
  return snapshotCount ?? inventoryFallbackDevices(inventory).length;
}

/** 真实列表优先，否则用估计值；磁贴至少占一格，所以至少算一台 */
export function resolveNodeDeviceCount(live: number | undefined, estimate: number): number {
  return Math.max(1, live ?? estimate);
}

export interface NodeDeviceCounts {
  countOf: (nodeId: string) => number;
  /** 面板拿到真实设备列表时调用；引用稳定，可以直接当 effect 依赖 */
  report: (nodeId: string, count: number) => void;
}

export function useNodeDeviceCounts(nodes: readonly NodeDeviceCountSource[]): NodeDeviceCounts {
  const [live, setLive] = useState<Record<string, number>>({});
  const snapshotsRef = useRef<ReadonlyMap<string, number | null>>(new Map());
  // 在渲染期就算好（而不是 effect 里）：首帧的磁贴宽度就要用到。写 ref 是幂等的
  const estimates = useMemo(() => {
    const snapshots = nextSnapshotCounts(snapshotsRef.current, nodes);
    snapshotsRef.current = snapshots;
    return new Map(
      nodes.map((node) => [
        node.runtimeNodeId,
        estimateNodeDeviceCount(snapshots.get(node.runtimeNodeId), node.inventory),
      ])
    );
  }, [nodes]);

  const report = useCallback((nodeId: string, count: number) => {
    setLive((prev) => (prev[nodeId] === count ? prev : { ...prev, [nodeId]: count }));
  }, []);
  const countOf = useCallback(
    (nodeId: string) => resolveNodeDeviceCount(live[nodeId], estimates.get(nodeId) ?? 1),
    [live, estimates]
  );
  return { countOf, report };
}
