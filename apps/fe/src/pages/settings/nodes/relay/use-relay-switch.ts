// 「切到另一条中继」：一次确认 + 一次 `POST /switch`。
//
// 与其余中继动作不同，切换不写密钥日志、不动成员，因此不走 `prompt.withSigner`——
// 它只是本机自己换一条上行链路，凭据就是当前的 node-session。
//
// 状态放在一份普通 store 里（`createRelaySwitchCore`），hook 只做订阅与文案：
// 「在途期间锁死」这类时序脱开 React 才测得出，没有 DOM 的单测跑不了交互。

import { createStateStore } from '@/node/create-polling-store';
import { switchMeshRelay } from '@/node/mesh-relay';
import type { RelayLinkStatus, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi, relayErrorCode } from '@tmex/api-client/relay/tenant-api';
import { useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { relayLabel } from './relay-rows';
import { relayErrorText } from './use-relay-actions';

export interface RelaySwitchState {
  /** 正在确认要切到哪一条；没有待确认时为 `null`。 */
  target: RelayLinkStatus | null;
  busy: boolean;
}

export interface RelaySwitchController extends RelaySwitchState {
  request: (relay: RelayLinkStatus) => void;
  dismiss: () => void;
  confirm: () => Promise<void>;
}

export interface RelaySwitchDeps {
  relayApi?: RelayTenantApi;
  onChanged?: () => void;
}

export interface RelaySwitchCoreDeps {
  switchRelay: (url: string) => Promise<void>;
  onDone?: (relay: RelayLinkStatus) => void;
  onError?: (error: unknown) => void;
}

export interface RelaySwitchCore {
  getState: () => RelaySwitchState;
  subscribe: (listener: () => void) => () => void;
  request: (relay: RelayLinkStatus) => void;
  dismiss: () => void;
  confirm: () => Promise<void>;
}

/** 切换失败的文案：认得出 code 就逐条翻译，网络层的异常一律归到「切换失败」。 */
export function relaySwitchErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  error: unknown
): string {
  return relayErrorText(t, relayErrorCode(error) ?? 'RELAY_SWITCH_FAILED');
}

/**
 * 切换的状态机。一次 `POST /switch` 要好几秒，这期间换目标、关框、再确认全部忽略：
 * 否则先回来的那次会把后一个目标的确认框关掉，界面指向也跟着错位。
 */
export function createRelaySwitchCore(deps: RelaySwitchCoreDeps): RelaySwitchCore {
  const store = createStateStore<RelaySwitchState>({ target: null, busy: false });

  const confirm = async () => {
    const { target, busy } = store.get();
    if (!target || busy) return;
    store.set({ busy: true });
    try {
      await deps.switchRelay(target.url);
      deps.onDone?.(target);
      // 只关掉这次动作自己那张框
      if (store.get().target?.url === target.url) store.set({ target: null });
    } catch (err) {
      deps.onError?.(err);
    } finally {
      store.set({ busy: false });
    }
  };

  return {
    getState: store.get,
    subscribe: store.subscribe,
    request: (relay) => {
      if (!store.get().busy) store.set({ target: relay });
    },
    dismiss: () => {
      if (!store.get().busy) store.set({ target: null });
    },
    confirm,
  };
}

export function useRelaySwitch(deps: RelaySwitchDeps = {}): RelaySwitchController {
  const { t } = useTranslation();
  // core 只建一次，回调却要看得见最新的 t / onChanged。
  const latest = useRef({ deps, t });
  latest.current = { deps, t };

  const [core] = useState(() =>
    createRelaySwitchCore({
      switchRelay: (url) =>
        switchMeshRelay(url, latest.current.deps.relayApi ?? defaultRelayTenantApi),
      onDone: (relay) => {
        const cur = latest.current;
        toast.success(cur.t('relay.tenant.switch.done', { host: relayLabel(relay.url) }));
        cur.deps.onChanged?.();
      },
      onError: (err) => toast.error(relaySwitchErrorText(latest.current.t, err)),
    })
  );

  const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);
  return {
    target: state.target,
    busy: state.busy,
    request: core.request,
    dismiss: core.dismiss,
    confirm: core.confirm,
  };
}
