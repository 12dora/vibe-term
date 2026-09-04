// 中继动作的目标挑选、次级菜单的条目表，以及「上级不可写」那一句。

import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { relayLabel } from '../relay/relay-rows';

/**
 * 该对哪条中继重新输入接入密码：被踢的那条才是要重新 enroll 的目标。
 * 一条都没被踢时退回当前挂载的那条（手动重输的场景）。
 */
export function reauthTarget(relays: RelayLinkStatus[]): string | null {
  const kicked = relays.filter((relay) => relay.kicked === true);
  if (kicked.length > 0) return kicked[0]?.url ?? null;
  return relays.find((relay) => relay.attached)?.url ?? relays[0]?.url ?? null;
}

/** 被踢的中继列表；多于一条时逐条列出来让用户自己选。 */
export function kickedRelays(relays: RelayLinkStatus[]): RelayLinkStatus[] {
  return relays.filter((relay) => relay.kicked === true);
}

export interface RelayMenuAction {
  kind: 'reauth' | 'remove';
  /** 动作打到哪条中继。 */
  url: string;
  key: string;
  params?: { host: string };
  testId: string;
}

/**
 * 次级菜单的条目：重新输入接入密码 → 逐条移除。
 *
 * 只有一条中继时不给「移除」——移除最后一条会被后端挡下（`RELAY_LAST`），正确的动作是
 * 「离开中继」，它单独摆在危险区里。多条被踢时逐条列，否则合成一条打到挑好的目标上。
 */
export function relayActionMenu(relays: RelayLinkStatus[]): RelayMenuAction[] {
  const kicked = kickedRelays(relays);
  const items: RelayMenuAction[] = [];
  if (kicked.length > 1) {
    for (const relay of kicked) {
      items.push({
        kind: 'reauth',
        url: relay.url,
        key: 'relay.tenant.actions.reauthOne',
        params: { host: relayLabel(relay.url) },
        testId: `nodes-relay-reauth-${relayLabel(relay.url)}`,
      });
    }
  } else {
    items.push({
      kind: 'reauth',
      url: reauthTarget(relays) ?? '',
      key: 'relay.tenant.actions.reauth',
      testId: 'nodes-relay-reauth-menu',
    });
  }
  if (relays.length > 1) {
    for (const relay of relays) {
      items.push({
        kind: 'remove',
        url: relay.url,
        key: 'relay.tenant.actions.removeOne',
        params: { host: relayLabel(relay.url) },
        testId: `nodes-relay-remove-${relayLabel(relay.url)}`,
      });
    }
  }
  return items;
}

/** 上级不可写时的那一句：中继模式说中继，hub 模式区分「备 Hub 拒写」与「主 Hub 不可达」。 */
export function uplinkBlockedHint(
  t: (key: string) => string,
  relayMode: boolean,
  writesBlocked: boolean
): string {
  if (relayMode) return t('relay.tenant.notAttached');
  return t(writesBlocked ? 'nodes.hubs.standbyNotice' : 'nodes.hubOffline');
}
