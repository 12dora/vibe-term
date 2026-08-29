// TLS 变更的串行化：保存与续签共用一把锁，ACME 后台签发期间同样算「忙」。
//
// 三件事必须互斥：`PUT /api/tls` 会重建监听、`POST /api/tls/renew` 会重签证书、ACME 的后台签发
// 会在成功后自己换证并重启监听。并发下去要么白白消耗 ACME 配额，要么让监听状态和选中的模式对不上。
//
// 状态放在一个可订阅的控制器里而不是组件 state：这样锁的行为可以脱离 DOM 直接测。

import type { TlsApi } from '@tmex/api-client/local/tls-api';
import type { TlsStatusResponse, TlsUpdateRequest } from '@tmex/api-client/local/tls-types';
import { useMemo, useRef, useSyncExternalStore } from 'react';

export type TlsMutationKind = 'save' | 'renew';

export interface TlsMutationState {
  pending: TlsMutationKind | null;
  /** 等待用户确认的保存请求（会停掉正在服务的 https 监听）。 */
  confirming: TlsUpdateRequest | null;
}

export interface TlsMutationCallbacks {
  onStatus: (next: TlsStatusResponse) => void;
  onRefresh: () => void;
  onSaved: () => void;
  onRenewStarted: () => void;
  onError: (error: unknown) => void;
}

/** 切到 `none` / `external` 会立刻停掉内建 https 监听——如果它正在服务本页，就是自锁风险。 */
export function stopsRunningListener(
  req: TlsUpdateRequest,
  status: TlsStatusResponse | null
): boolean {
  if (!status?.listener.running) return false;
  return req.mode === 'none' || req.mode === 'external';
}

export function isTlsBusy(
  pending: TlsMutationKind | null,
  status: TlsStatusResponse | null
): boolean {
  return pending !== null || status?.acme?.status === 'pending';
}

export class TlsMutationController {
  private state: TlsMutationState = { pending: null, confirming: null };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly api: TlsApi,
    private readonly readStatus: () => TlsStatusResponse | null,
    private readonly readCallbacks: () => TlsMutationCallbacks
  ) {}

  snapshot = (): TlsMutationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get busy(): boolean {
    return isTlsBusy(this.state.pending, this.readStatus());
  }

  /** 需要确认时只登记请求并返回，真正的 PUT 等 `confirmSave()`。 */
  requestSave = async (req: TlsUpdateRequest): Promise<void> => {
    if (this.busy || this.state.confirming) return;
    if (stopsRunningListener(req, this.readStatus())) {
      this.update({ confirming: req });
      return;
    }
    await this.runSave(req);
  };

  confirmSave = async (): Promise<void> => {
    const req = this.state.confirming;
    if (!req) return;
    this.update({ confirming: null });
    if (this.busy) return;
    await this.runSave(req);
  };

  cancelSave = (): void => {
    if (this.state.confirming) this.update({ confirming: null });
  };

  renew = async (): Promise<void> => {
    if (this.busy || this.state.confirming) return;
    this.update({ pending: 'renew' });
    try {
      const next = await this.api.renew();
      this.readCallbacks().onStatus(next);
      this.readCallbacks().onRenewStarted();
    } catch (error) {
      this.readCallbacks().onError(error);
      // 自签续签可能已经换过证书才在绑端口时失败（`port_in_use`），不重拉就一直显示旧证书。
      this.readCallbacks().onRefresh();
    } finally {
      this.update({ pending: null });
    }
  };

  private async runSave(req: TlsUpdateRequest): Promise<void> {
    this.update({ pending: 'save' });
    try {
      const next = await this.api.update(req);
      this.readCallbacks().onStatus(next);
      this.readCallbacks().onSaved();
    } catch (error) {
      this.readCallbacks().onError(error);
      // `port_in_use` 下模式已经落库、只是没绑上端口，必须重拉才能看到 listener.error。
      this.readCallbacks().onRefresh();
    } finally {
      this.update({ pending: null });
    }
  }

  private update(patch: Partial<TlsMutationState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export interface TlsMutations extends TlsMutationState {
  busy: boolean;
  requestSave: (req: TlsUpdateRequest) => void;
  confirmSave: () => void;
  cancelSave: () => void;
  renew: () => void;
}

export function useTlsMutations(
  api: TlsApi,
  status: TlsStatusResponse | null,
  callbacks: TlsMutationCallbacks
): TlsMutations {
  const statusRef = useRef(status);
  statusRef.current = status;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const controller = useMemo(
    () =>
      new TlsMutationController(
        api,
        () => statusRef.current,
        () => callbacksRef.current
      ),
    [api]
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );

  return {
    ...state,
    busy: isTlsBusy(state.pending, status),
    requestSave: (req) => void controller.requestSave(req),
    confirmSave: () => void controller.confirmSave(),
    cancelSave: controller.cancelSave,
    renew: () => void controller.renew(),
  };
}
