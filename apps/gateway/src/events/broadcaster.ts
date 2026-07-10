// 事件通知广播注册桥：channel 层无法直接引用 wsServer 实例（runtime 局部创建），
// 仿 settings/broadcaster.ts 的注册模式解耦。runtime.ts 启动时注册、stop 时注销。

import type { EventType, WebhookEvent } from '@tmex/shared';

type EventNotifyBroadcaster = (eventType: EventType, event: WebhookEvent) => void;

let broadcaster: EventNotifyBroadcaster | null = null;

export function registerEventNotifyBroadcaster(fn: EventNotifyBroadcaster | null): void {
  broadcaster = fn;
}

export function broadcastEventNotify(eventType: EventType, event: WebhookEvent): void {
  broadcaster?.(eventType, event);
}
