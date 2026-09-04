// 「切到另一条中继」：一次确认 + 一次 `POST /switch`。
//
// 与其余中继动作不同，切换不写密钥日志、不动成员，因此不走 `prompt.withSigner`——
// 它只是本机自己换一条上行链路，凭据就是当前的 node-session。

import { switchMeshRelay } from '@/node/mesh-relay';
import type { RelayLinkStatus, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi, relayErrorCode } from '@tmex/api-client/relay/tenant-api';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { relayLabel } from './relay-rows';
import { relayErrorText } from './use-relay-actions';

export interface RelaySwitchController {
  /** 正在确认要切到哪一条；没有待确认时为 `null`。 */
  target: RelayLinkStatus | null;
  busy: boolean;
  request: (relay: RelayLinkStatus) => void;
  dismiss: () => void;
  confirm: () => Promise<void>;
}

export interface RelaySwitchDeps {
  relayApi?: RelayTenantApi;
  onChanged?: () => void;
}

/** 切换失败的文案：认得出 code 就逐条翻译，网络层的异常一律归到「切换失败」。 */
export function relaySwitchErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  error: unknown
): string {
  return relayErrorText(t, relayErrorCode(error) ?? 'RELAY_SWITCH_FAILED');
}

export function useRelaySwitch(deps: RelaySwitchDeps = {}): RelaySwitchController {
  const { t } = useTranslation();
  const relayApi = deps.relayApi ?? defaultRelayTenantApi;
  const { onChanged } = deps;
  const [target, setTarget] = useState<RelayLinkStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const request = useCallback((relay: RelayLinkStatus) => setTarget(relay), []);
  const dismiss = useCallback(() => setTarget(null), []);

  const confirm = useCallback(async () => {
    if (!target) return;
    setBusy(true);
    try {
      await switchMeshRelay(target.url, relayApi);
      toast.success(t('relay.tenant.switch.done', { host: relayLabel(target.url) }));
      setTarget(null);
      onChanged?.();
    } catch (err) {
      toast.error(relaySwitchErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }, [onChanged, relayApi, t, target]);

  return { target, busy, request, dismiss, confirm };
}
