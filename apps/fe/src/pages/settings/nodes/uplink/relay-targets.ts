// 中继动作的目标挑选与「上级不可写」那一句。

import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';

/**
 * 该对哪条中继重新输口令：被踢的那条才是要重新 enroll 的目标。
 * 一条都没被踢时退回当前挂载的那条（手动重输口令的场景）。
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

/** 上级不可写时的那一句：中继模式说中继，hub 模式区分「备 Hub 拒写」与「主 Hub 不可达」。 */
export function uplinkBlockedHint(
  t: (key: string) => string,
  relayMode: boolean,
  writesBlocked: boolean
): string {
  if (relayMode) return t('relay.tenant.notAttached');
  return t(writesBlocked ? 'nodes.hubs.standbyNotice' : 'nodes.hubOffline');
}
