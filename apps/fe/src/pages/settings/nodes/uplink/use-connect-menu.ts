// 把上级控制器接到「连接」菜单上：状态取自 `LocalUplinkController`，动作全部复用它的对话框。

import type { LocalStatusResponse } from '@vibeterm/api-client/local/types';
import { RELAY_RECORD_MAX_RELAYS } from '@vibeterm/shared/auth';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { type ConnectMenuItem, connectMenuItems } from './connect-menu';
import type { LocalUplinkController } from './local-uplink-controller';

export interface UseConnectMenuOptions {
  status: LocalStatusResponse | null;
  uplink: LocalUplinkController;
  /** 退出 / 设置提交在途。 */
  locked: boolean;
}

export function useConnectMenu(options: UseConnectMenuOptions): ConnectMenuItem[] {
  const { t } = useTranslation();
  const { status, uplink } = options;
  const { relay, relayActions } = uplink;
  if (!status) return [];
  return connectMenuItems(
    t,
    {
      role: status.role,
      relayMode: relay.relayMode,
      unsupported: relay.unsupported === true,
      relays: relay.ordered,
    },
    {
      addRelay: () => relayActions.openEnroll('add'),
      notifyRelayLimit: () =>
        toast.error(t('relay.tenant.actions.addMax', { n: RELAY_RECORD_MAX_RELAYS })),
      reauthRelay: (url) => relayActions.openEnroll('reauth', url),
      removeRelay: (url) => relayActions.requestConfirm('remove', url),
      leaveRelay: () => relayActions.requestConfirm('leave'),
    }
  );
}
