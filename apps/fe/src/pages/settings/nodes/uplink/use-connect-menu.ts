// 把上级控制器接到「连接」菜单上：状态取自 `LocalUplinkController`，动作全部复用它的对话框。

import type { LocalStatusResponse } from '@vibeterm/api-client/local/types';
import { useTranslation } from 'react-i18next';
import { type ConnectMenuItem, connectMenuItems } from './connect-menu';
import type { LocalUplinkController } from './local-uplink-controller';

export interface UseConnectMenuOptions {
  status: LocalStatusResponse | null;
  uplink: LocalUplinkController;
  /** 退出 / 设置提交在途。 */
  locked: boolean;
  onChangeHub: () => void;
}

export function useConnectMenu(options: UseConnectMenuOptions): ConnectMenuItem[] {
  const { t } = useTranslation();
  const { status, uplink, locked, onChangeHub } = options;
  const { relay, relayActions } = uplink;
  if (!status) return [];
  return connectMenuItems(
    t,
    {
      role: status.role,
      relayMode: relay.relayMode,
      uplinkMode: relay.mode,
      unsupported: relay.unsupported === true,
      relays: relay.ordered,
      changeHubDisabled: locked,
    },
    {
      changeHub: onChangeHub,
      migrateToRelay: () => relayActions.openEnroll('migrate'),
      addRelay: () => relayActions.openEnroll('add'),
      reauthRelay: (url) => relayActions.openEnroll('reauth', url),
      removeRelay: (url) => relayActions.requestConfirm('remove', url),
      leaveRelay: () => relayActions.requestConfirm('leave'),
    }
  );
}
