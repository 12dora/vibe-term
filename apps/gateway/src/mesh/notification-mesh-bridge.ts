// 通知转发用的 mesh 桥：由 mesh-runtime 在装配后注入，standalone / 纯中继下恒为 null。
// events 层不认识 mesh 装配，只经这层拿汇聚机集合与投递通道（与 mesh-agent-bridge 同构）。

import type { MeshNotificationForwardRequest, MeshNotificationSink } from '@tmex/shared';

export interface MeshNotificationBridge {
  selfNodeId(): string;
  selfName(): string | null;
  /** 当前已知的汇聚机集合（含本机，`self` 标记区分）。 */
  listSinks(): MeshNotificationSink[];
  /** 投递到指定汇聚机；走对端链路的内部 HTTP，带对端标记。 */
  deliver(sinkNodeId: string, body: MeshNotificationForwardRequest): Promise<Response>;
  /** 本机开关变化后立刻重播 node.status / peer.status，不等心跳。 */
  advertise(): void;
}

let bridge: MeshNotificationBridge | null = null;

export function setMeshNotificationBridge(next: MeshNotificationBridge | null): void {
  bridge = next;
}

export function getMeshNotificationBridge(): MeshNotificationBridge | null {
  return bridge;
}
