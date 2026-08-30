// 远程访问动作的串行化：所有变更共用一把锁，后台 job 在跑时同样算「忙」。
//
// 后端对并发动作直接返回 409（`busy`），前端先自己挡一层：安装、登录、创建、启停都会改同一份
// 主机状态，抢着发只会拿到一串 409，还会让按钮的挂起态和实际进度对不上。
// 唯一的例外是 `cancel_login`——它存在的意义就是打断正在跑的 login job。
//
// 状态放在可订阅的控制器里而不是组件 state：锁与错误处理可以脱离 DOM 直接测。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { runTunnelAction } from '@tmex/api-client/local/tunnel-api';
import type { TunnelActionRequest, TunnelActionResponse, TunnelStatusResponse } from '@tmex/shared';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { type TunnelError, toTunnelError } from './tunnel-model';

export type TunnelActionName = TunnelActionRequest['action'];

export interface TunnelCheckResult {
  ok: boolean;
  message: string | null;
}

export interface TunnelActionState {
  pending: TunnelActionName | null;
  error: TunnelError | null;
  /** 最近一次「检查连通性」的结果。 */
  check: TunnelCheckResult | null;
}

export interface TunnelActionCallbacks {
  onStatus: (next: TunnelStatusResponse) => void;
  onRefresh: () => void;
}

export type RunTunnelAction = (body: TunnelActionRequest) => Promise<TunnelActionResponse>;

export function isTunnelBusy(
  pending: TunnelActionName | null,
  status: TunnelStatusResponse | null
): boolean {
  return pending !== null || status?.job?.state === 'running';
}

const INITIAL: TunnelActionState = { pending: null, error: null, check: null };

export class TunnelActionController {
  private state: TunnelActionState = INITIAL;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly runAction: RunTunnelAction,
    private readonly readStatus: () => TunnelStatusResponse | null,
    private readonly readCallbacks: () => TunnelActionCallbacks
  ) {}

  snapshot = (): TunnelActionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return isTunnelBusy(this.state.pending, this.readStatus());
  }

  clearError = (): void => {
    if (this.state.error) this.update({ error: null });
  };

  run = async (req: TunnelActionRequest): Promise<void> => {
    if (this.state.pending !== null) return;
    if (req.action !== 'cancel_login' && this.readStatus()?.job?.state === 'running') return;

    this.update({
      pending: req.action,
      error: null,
      check: req.action === 'check' ? null : this.state.check,
    });
    try {
      const res = await this.runAction(req);
      this.readCallbacks().onStatus(res.status);
      if (req.action === 'check') this.update({ check: checkResultOf(res) });
    } catch (error) {
      this.update({ error: toTunnelError(error) });
      // 失败时服务端状态很可能已经变了（进程退出、job 转 error），必须重拉才看得到。
      this.readCallbacks().onRefresh();
    } finally {
      this.update({ pending: null });
    }
  };

  private update(patch: Partial<TunnelActionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** `check` 是同步动作：结果落在响应的 job 上，job 带 error 即不可达。 */
export function checkResultOf(res: TunnelActionResponse): TunnelCheckResult {
  const job = res.job;
  if (job?.error) return { ok: false, message: job.error.message || job.error.code };
  return { ok: job?.state !== 'error', message: null };
}

export interface TunnelActions extends TunnelActionState {
  busy: boolean;
  run: (req: TunnelActionRequest) => void;
  clearError: () => void;
}

export interface UseTunnelActionsOptions {
  client?: ApiClient;
  /** 测试注入；默认打 `POST /api/tunnel/actions`。 */
  runAction?: RunTunnelAction;
}

export function useTunnelActions(
  status: TunnelStatusResponse | null,
  callbacks: TunnelActionCallbacks,
  options: UseTunnelActionsOptions = {}
): TunnelActions {
  const statusRef = useRef(status);
  statusRef.current = status;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const client = options.client ?? defaultApiClient;
  const injected = options.runAction;
  const controller = useMemo(
    () =>
      new TunnelActionController(
        injected ?? ((body) => runTunnelAction(body, client)),
        () => statusRef.current,
        () => callbacksRef.current
      ),
    [client, injected]
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );

  return {
    ...state,
    busy: isTunnelBusy(state.pending, status),
    run: (req) => void controller.run(req),
    clearError: controller.clearError,
  };
}
