// 向导侧的重启等待：`/api/setup/hub|join` 自己会重启网关，这里只需要等，不需要再 POST 一次。
// 实现全部落在共享核心 `../restart/wait-for-restart.ts`，本文件只保留向导用的状态名。

import type { ApiClient } from '@tmex/api-client';
import { type RestartState, useRestartNow } from '../restart/use-restart-now';

export type RestartWaiterState = RestartState;

export interface RestartWaiter {
  state: RestartWaiterState;
  elapsedMs: number;
  start(previousStartedAt: number | null): void;
}

export function useRestartWaiter({ client }: { client?: ApiClient } = {}): RestartWaiter {
  const restart = useRestartNow(client ? { client } : {});
  return { state: restart.state, elapsedMs: restart.elapsedMs, start: restart.start };
}
