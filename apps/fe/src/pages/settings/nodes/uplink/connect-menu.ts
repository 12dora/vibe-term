// 卡片 ⋯ 菜单里「连接」那一组：按当前上级形态算出该给哪些动作。
//
// 这些动作全都低频且各自带确认对话框，摆在卡面上只会和「现在连着谁」抢版面；
// 唯一留在卡面的是「还没有上级」那一档——那时界面必须自己要求一个动作。

import type { LocalRole } from '@vibeterm/api-client/local/types';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { RELAY_RECORD_MAX_RELAYS } from '@vibeterm/shared/auth';
import { isRelayRole } from '../membership/role-transition';
import { relayActionMenu } from './relay-targets';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface ConnectMenuItem {
  key: string;
  label: string;
  testId: string;
  destructive?: boolean;
  disabled?: boolean;
  /** 禁用时的悬停解释；没有理由可说时缺席。 */
  title?: string;
  onSelect: () => void;
}

export interface ConnectMenuState {
  role: LocalRole;
  /** 本机已是中继租户（`/api/mesh/relay/status` 报 `relay`）。 */
  relayMode: boolean;
  /** 后端报的上级形态；中继角色尚未接入时也会报 `hub`，因此还要看角色。 */
  uplinkMode: string;
  /** 旧节点没有这族路由：一个中继动作都不给。 */
  unsupported: boolean;
  relays: RelayLinkStatus[];
  /** 退出 / 设置提交在途：换 Hub 会得到 409。 */
  changeHubDisabled: boolean;
}

export interface ConnectMenuHandlers {
  changeHub: () => void;
  migrateToRelay: () => void;
  addRelay: () => void;
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
  // 满 16 条时先禁掉：`set-relays` 的协议上限就是这个数，再签一条也只会在中继侧
  // 以 `malformed_payload` 告终，那时用户已经把接入密码输完了。
  const full = state.relays.length >= RELAY_RECORD_MAX_RELAYS;
  const items: ConnectMenuItem[] = [
    {
      key: 'relay-add',
      label: t('relay.tenant.actions.add'),
      testId: 'nodes-relay-add',
      ...(full
        ? {
            disabled: true,
            title: t('relay.tenant.actions.addMax', { n: RELAY_RECORD_MAX_RELAYS }),
          }
        : {}),
      onSelect: handlers.addRelay,
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

/** Hub 形态：纯节点可以换 Hub，两种 Hub 形态都可以改走中继。 */
function hubItems(
  t: Translate,
  state: ConnectMenuState,
  handlers: ConnectMenuHandlers
): ConnectMenuItem[] {
  const items: ConnectMenuItem[] = [];
  if (state.role === 'node') {
    items.push({
      key: 'change-hub',
      label: t('nodes.membership.changeHub'),
      testId: 'local-machine-change-hub',
      disabled: state.changeHubDisabled,
      onSelect: handlers.changeHub,
    });
  }
  // 中继角色的上级只可能是自己的中继，「改为接入中继」对它没有意义（入口在连接段）。
  if (!state.unsupported && state.uplinkMode === 'hub' && !isRelayRole(state.role)) {
    items.push({
      key: 'relay-migrate',
      label: t('relay.tenant.actions.migrate'),
      testId: 'nodes-relay-enroll',
      onSelect: handlers.migrateToRelay,
    });
  }
  return items;
}

export function connectMenuItems(
  t: Translate,
  state: ConnectMenuState,
  handlers: ConnectMenuHandlers
): ConnectMenuItem[] {
  if (state.relayMode) return state.unsupported ? [] : relayTenantItems(t, state, handlers);
  return hubItems(t, state, handlers);
}
