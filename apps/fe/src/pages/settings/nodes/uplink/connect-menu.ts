// 卡片 ⋯ 菜单里「连接」那一组：按当前上级形态算出该给哪些动作。
//
// 这些动作全都低频且各自带确认对话框，摆在卡面上只会和「现在连着谁」抢版面；
// 唯一留在卡面的是「还没有上级」那一档——那时界面必须自己要求一个动作。

import type { LocalRole } from '@vibeterm/api-client/local/types';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { RELAY_RECORD_MAX_RELAYS } from '@vibeterm/shared/auth';
import { relayActionMenu } from './relay-targets';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface ConnectMenuItem {
  key: string;
  label: string;
  testId: string;
  destructive?: boolean;
  disabled?: boolean;
  /**
   * 「点了也没用」的理由：同时用作悬停提示与 `aria-describedby` 指向的 sr-only 文本。
   * 禁用项在 Base UI 里不收指针事件（`data-disabled:pointer-events-none`），
   * 原生 title 根本不会出，所以带理由的项一律保持可点，点了给一条 toast。
   */
  reason?: string;
  onSelect: () => void;
}

export interface ConnectMenuState {
  role: LocalRole;
  /** 本机已是中继租户（`/api/mesh/relay/status` 报 `relay`）。 */
  relayMode: boolean;
  /** 旧节点没有这族路由：一个中继动作都不给。 */
  unsupported: boolean;
  relays: RelayLinkStatus[];
}

export interface ConnectMenuHandlers {
  addRelay: () => void;
  /** 已达上限时点「追加中继」：不开对话框，只说明为什么。 */
  notifyRelayLimit: () => void;
  reauthRelay: (url: string) => void;
  removeRelay: (url: string) => void;
  leaveRelay: () => void;
}

/** 中继租户形态：追加 / 重新输入接入密码 / 逐条移除 / 离开。 */
function relayTenantItems(
  t: Translate,
  state: ConnectMenuState,
  handlers: ConnectMenuHandlers
): ConnectMenuItem[] {
  const full = state.relays.length >= RELAY_RECORD_MAX_RELAYS;
  const items: ConnectMenuItem[] = [
    {
      key: 'relay-add',
      label: t('relay.tenant.actions.add'),
      testId: 'nodes-relay-add',
      ...(full ? { reason: t('relay.tenant.actions.addMax', { n: RELAY_RECORD_MAX_RELAYS }) } : {}),
      onSelect: full ? handlers.notifyRelayLimit : handlers.addRelay,
    },
  ];
  for (const action of relayActionMenu(state.relays)) {
    items.push({
      key: action.testId,
      label: t(action.key, action.params),
      testId: action.testId,
      onSelect:
        action.kind === 'reauth'
          ? () => handlers.reauthRelay(action.url)
          : () => handlers.removeRelay(action.url),
    });
  }
  items.push({
    key: 'relay-leave',
    label: t('relay.tenant.actions.leave'),
    testId: 'nodes-relay-leave',
    destructive: true,
    onSelect: handlers.leaveRelay,
  });
  return items;
}

export function connectMenuItems(
  t: Translate,
  state: ConnectMenuState,
  handlers: ConnectMenuHandlers
): ConnectMenuItem[] {
  if (state.relayMode) return state.unsupported ? [] : relayTenantItems(t, state, handlers);
  return [];
}
