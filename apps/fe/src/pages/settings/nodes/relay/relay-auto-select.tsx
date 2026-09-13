// 卡片上那一行「固定 / 自动优选」。
//
// 「设为主中继」会把那条记成固定值（`relay.preferredUrl`），固定期间自动优选整个冻结——
// 这件事必须在卡面上说清，否则用户只会看到主中继从此再也不动，却找不到是哪一步定住的。
// 于是固定态给一句陈述加一个「取消固定」，未固定且自动优选开着时只给一句陈述。
//
// 状态判定是纯的（`relay-row-model.ts` 的 `relayAutoSelectState`），这里只管渲染与那次 POST。

import { formatRelative } from '@/lib/format-relative';
import { unpinMeshRelay } from '@/node/mesh-relay';
import type { RelayAutoSelectView, RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { relayErrorCode } from '@vibeterm/api-client/relay/tenant-api';
import { Button } from '@vibeterm/ui/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { relayAutoSelectState } from './relay-row-model';
import { relayErrorText } from './use-relay-actions';

export interface RelayAutoSelectLineProps {
  /** 用户固定的主中继地址；未固定为 `null`。 */
  preferredUrl?: string | null;
  autoSelect?: RelayAutoSelectView;
  /** 只有多条同时挂载时这行才有意义：一条中继没什么可优选、也没什么可固定的。 */
  multiAttach: boolean;
  /** 测试注入。 */
  relayApi?: RelayTenantApi;
}

export function RelayAutoSelectLine({
  preferredUrl,
  autoSelect,
  multiAttach,
  relayApi,
}: RelayAutoSelectLineProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const state = relayAutoSelectState({ preferredUrl, autoSelect });
  if (!multiAttach || state.kind === 'none' || !state.hintKey) return null;

  const unpin = async () => {
    setBusy(true);
    try {
      await unpinMeshRelay(relayApi);
      toast.success(t('relay.tenant.autoSelect.unpinDone'));
    } catch (err) {
      toast.error(relayErrorText(t, relayErrorCode(err) ?? 'RELAY_UNPIN_FAILED'));
    } finally {
      setBusy(false);
    }
  };

  const lastSwitch = formatRelative(t, state.lastSwitchAt, Date.now(), 'relay.admin.time');
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"
      data-testid="nodes-relay-auto-select"
      data-relay-auto-select={state.kind}
    >
      <span className="min-w-0">
        {t(state.hintKey)}
        {lastSwitch ? ` · ${t('relay.tenant.autoSelect.lastSwitch', { time: lastSwitch })}` : ''}
      </span>
      {state.kind === 'pinned' && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => void unpin()}
          data-testid="nodes-relay-unpin"
        >
          {t('relay.tenant.autoSelect.unpin')}
        </Button>
      )}
    </p>
  );
}
