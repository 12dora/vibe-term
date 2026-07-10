import type { EventType, WebhookEvent } from '@tmex/shared';
import { broadcastEventNotify } from '../broadcaster';
import type { NotificationChannel } from './types';

// 经注册桥把事件转发为 /ws 的 KIND_NOTIFY_EVENT 广播。桥未注册时静默 no-op。
// 不检查 enableBellPush / enableNotificationPush：那是各推送渠道
// （webhook/telegram/weixin）自己的开关，WS 广播不受其影响。
export class WsBroadcastChannel implements NotificationChannel {
  readonly id = 'ws-broadcast';

  async notify(eventType: EventType, event: WebhookEvent): Promise<void> {
    try {
      broadcastEventNotify(eventType, event);
    } catch (err) {
      console.error('[ws-broadcast] failed to broadcast event:', err);
    }
  }
}

export const wsBroadcastChannel = new WsBroadcastChannel();
