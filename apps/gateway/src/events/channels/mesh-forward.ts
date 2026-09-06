// 内置渠道 `mesh-forward`：把本机产生的事件转发给所有汇聚机（不含本机）。
//
// 不转发的两类：
//   1. `payload.nodeId` 非空——要么是发起机代远端 agent 会话上报的 `agent_*`（汇聚机
//      本来就会收到发起机那份），要么是本机作为汇聚机刚收下的转发件，再转一次会成环；
//   2. 没有汇聚机时直接返回，不建队列。

import type { EventType, MeshNotificationForwardRequest, WebhookEvent } from '@tmex/shared';
import {
  type MeshNotificationBridge,
  getMeshNotificationBridge,
  onMeshNotificationBridgeChange,
} from '../../mesh/notification-mesh-bridge';
import { MeshNotificationForwarder } from '../mesh-forwarder';
import { resolveNotificationNodeName } from './notification-format';
import type { NotificationChannel } from './types';

export function isLocallyOriginatedEvent(event: WebhookEvent): boolean {
  const raw = event.payload?.nodeId;
  return typeof raw !== 'string' || raw.trim().length === 0;
}

export function buildForwardRequest(
  eventType: EventType,
  event: WebhookEvent,
  origin: { nodeId: string; nodeName: string }
): MeshNotificationForwardRequest {
  const { eventType: _type, timestamp: _ts, ...rest } = event;
  return { eventType, event: rest, origin };
}

export class MeshForwardChannel implements NotificationChannel {
  readonly id = 'mesh-forward';

  private forwarder: MeshNotificationForwarder | null = null;
  private boundBridge: MeshNotificationBridge | null = null;

  constructor() {
    // 桥换人或 mesh 停机时立刻收掉旧队列：否则退休运行时上的重试定时器会一直活着。
    onMeshNotificationBridgeChange((next) => {
      if (next !== this.boundBridge) this.detach();
    });
  }

  /** 丢掉当前转发器（取消定时器与在途投递）；下一次 notify 会按新桥重建。 */
  detach(): void {
    this.forwarder?.stop();
    this.forwarder = null;
    this.boundBridge = null;
  }

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    const bridge = getMeshNotificationBridge();
    if (!bridge || !isLocallyOriginatedEvent(event)) return;
    const targets = bridge.listSinks().filter((sink) => !sink.self);
    if (targets.length === 0) return;
    const origin = {
      nodeId: bridge.selfNodeId(),
      nodeName: bridge.selfName() ?? resolveNotificationNodeName() ?? '',
    };
    if (!origin.nodeId) return;
    const body = buildForwardRequest(eventType, event, origin);
    const forwarder = this.forwarderFor(bridge);
    for (const sink of targets) forwarder.enqueue(sink.nodeId, body);
  }

  /** 队列统计：`GET /api/notifications/mesh` 用来展示待发/丢弃数。 */
  stats(): { pending: number; dropped: number } {
    return { pending: this.forwarder?.pending ?? 0, dropped: this.forwarder?.dropped ?? 0 };
  }

  private forwarderFor(bridge: MeshNotificationBridge): MeshNotificationForwarder {
    if (this.forwarder && this.boundBridge === bridge) return this.forwarder;
    this.forwarder?.stop();
    this.boundBridge = bridge;
    this.forwarder = new MeshNotificationForwarder({
      deliver: (sinkNodeId, body, signal) => bridge.deliver(sinkNodeId, body, signal),
    });
    return this.forwarder;
  }
}

export const meshForwardChannel = new MeshForwardChannel();
