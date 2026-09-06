// 通知转发用的 mesh 桥：由 mesh-runtime 在装配后注入，standalone / 纯中继下恒为 null。
// events 层不认识 mesh 装配，只经这层拿汇聚机集合与投递通道（与 mesh-agent-bridge 同构）。

import type { MeshNotificationForwardRequest, MeshNotificationSink } from '@vibeterm/shared';

export interface MeshNotificationBridge {
  selfNodeId(): string;
  selfName(): string | null;
  /** 本机是否为汇聚机：用户签过的 `notification-sink` 声明 + 本机开关。 */
  selfSinkEnabled(): boolean;
  /** 目标节点当前是否仍是用户签过的汇聚机；每次投递前都要问。 */
  sinkAuthorized(nodeId: string): boolean;
  /** 当前已知的汇聚机集合（含本机，`self` 标记区分）。 */
  listSinks(): MeshNotificationSink[];
  /** 投递到指定汇聚机；走对端链路的内部 HTTP，带对端标记。`signal` 是单次投递的截止信号。 */
  deliver(
    sinkNodeId: string,
    body: MeshNotificationForwardRequest,
    signal?: AbortSignal
  ): Promise<Response>;
}

type BridgeListener = (next: MeshNotificationBridge | null) => void;

let bridge: MeshNotificationBridge | null = null;
const listeners = new Set<BridgeListener>();

/** 桥被替换或清空（mesh 运行时停机）时回调，转发器据此收掉退休运行时上的队列与定时器。 */
export function onMeshNotificationBridgeChange(listener: BridgeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMeshNotificationBridge(next: MeshNotificationBridge | null): void {
  if (bridge === next) return;
  bridge = next;
  for (const listener of listeners) listener(next);
}

export function getMeshNotificationBridge(): MeshNotificationBridge | null {
  return bridge;
}
