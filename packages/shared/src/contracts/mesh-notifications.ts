// 跨节点通知汇聚（mesh notification sink）契约。
//
// 汇聚机 = 用户签过 `notification-sink` 记录（`enabled: true`）且本机开关也打开的机器，
// 可以有多台。每台节点把本机产生的事件转发给除自己以外的全部汇聚机，由汇聚机用**它自己**的
// 通知渠道发出去。汇聚集合只认密钥日志里的签名声明，不认节点自述的 inventory。

import type { EventType, WebhookEvent } from './notifications';

/** 汇聚开关的读写端点（浏览器侧）。 */
export const MESH_NOTIFICATION_ROUTE = '/api/notifications/mesh';

/** 节点→汇聚机的内部投递端点（对端标记保护，浏览器不可达）。 */
export const MESH_INTERNAL_NOTIFICATION_ROUTE = '/api/mesh-internal/notifications';

/** 汇聚机开关的设置广播命名空间，前端据此失效缓存。 */
export const MESH_NOTIFICATION_SETTINGS_NAMESPACE = 'notifications-mesh';

export interface MeshNotificationSink {
  nodeId: string;
  name: string;
  self: boolean;
  online: boolean;
}

export interface MeshNotificationForwardQueueStats {
  /** 当前所有汇聚机队列里待发的事件条数。 */
  pending: number;
  /** 进程启动以来因超限/过期被丢弃的事件条数。 */
  dropped: number;
}

export interface MeshNotificationState {
  /** standalone / 纯中继没有 mesh，卡片不显示。 */
  supported: boolean;
  /** 本机节点编号；前端签 `notification-sink` 记录时要写进 payload。无 mesh 时缺省。 */
  selfNodeId?: string;
  selfEnabled: boolean;
  sinks: MeshNotificationSink[];
  forwardQueue?: MeshNotificationForwardQueueStats;
}

export interface UpdateMeshNotificationRequest {
  enabled: boolean;
}

/** 节点→汇聚机的投递体。`event` 不带 `eventType` / `timestamp`：两者由汇聚机重建。 */
export interface MeshNotificationForwardRequest {
  eventType: EventType;
  event: Omit<WebhookEvent, 'eventType' | 'timestamp'>;
  origin: {
    nodeId: string;
    nodeName: string;
  };
}
