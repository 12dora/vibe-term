// 会话动作各域工厂共享的依赖形状与错误上报。

import type { ApiClient } from '@tmex/api-client';
import type { NotificationSink } from '@tmex/notifications';
import type { AgentHistorySync } from './agent-history-sync';
import type { AgentGetState, AgentSetState } from './agent-state';

export interface AgentSessionActionsDeps {
  apiClient: ApiClient;
  notifications: NotificationSink;
  set: AgentSetState;
  get: AgentGetState;
  history: AgentHistorySync;
  /** 订阅该 session 的流式事件 */
  subscribe: (sessionId: string) => void;
  /** 取消订阅（未订阅时无副作用） */
  unsubscribe: (sessionId: string) => void;
  /** 清理该 session 的运行时缓冲（delta 缓冲、去抖定时器等） */
  clearSessionRuntime: (sessionId: string) => void;
}

export function reportActionError(notifications: NotificationSink, error: unknown): void {
  notifications.error(error instanceof Error ? error.message : String(error));
}
