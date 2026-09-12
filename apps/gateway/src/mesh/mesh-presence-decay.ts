import { isPeerReachable } from './address-class';
import { stamp } from './mesh-log';
import type { PeerReach } from './types';
import type { UplinkNodeList } from './uplink-protocol';

/**
 * uplink 抖一下不等于对端全下线：掉线后 `HUB_PRESENCE_STALE_MS` 内继续沿用最后一次 hub presence，
 * 到期还没接回来才退化成「只认 peer 可达性」并补发离线事件。重连后本代 node.list 到达即恢复权威。
 */
export const HUB_PRESENCE_STALE_MS = 90_000;
let hubPresenceStaleMs = HUB_PRESENCE_STALE_MS;

/** 测试用：缩短陈旧窗口，免得等满 90 s。 */
export function setHubPresenceStaleMs(ms: number): void {
  hubPresenceStaleMs = ms > 0 ? ms : HUB_PRESENCE_STALE_MS;
}

export type HubPresenceState = {
  lastNodeList: UplinkNodeList | null;
  hubPresenceLive: boolean;
  hubPresenceStaleUntil: number;
  hubPresenceDecay: { clear: () => void } | null;
};

export function hubPresenceUsable(
  state: HubPresenceState,
  uplinkOnline: boolean,
  now: number
): boolean {
  if (!state.lastNodeList) return false;
  if (state.hubPresenceLive) return true;
  return !uplinkOnline && now < state.hubPresenceStaleUntil;
}

export function clearHubPresenceDecay(state: HubPresenceState): void {
  state.hubPresenceDecay?.clear();
  state.hubPresenceDecay = null;
  state.hubPresenceStaleUntil = 0;
}

export function listHubOnlineIds(
  state: HubPresenceState,
  uplinkOnline: boolean,
  now: number,
  union: Set<string> | null
): Set<string> {
  if (union) return union;
  const ids = new Set<string>();
  if (!hubPresenceUsable(state, uplinkOnline, now) || !state.lastNodeList) return ids;
  for (const node of state.lastNodeList.nodes) {
    if (node.online) ids.add(node.id);
  }
  return ids;
}

export function scheduleHubPresenceDecay(
  d: {
    identity: { nodeIdHex: string };
    scheduler: {
      now: () => number;
      interval: (fn: () => void, ms: number) => { clear: () => void };
    };
    emitSyntheticOffline: (nodeId: string) => void;
  },
  state: HubPresenceState,
  reachOf: () => Map<string, PeerReach>
): void {
  clearHubPresenceDecay(state);
  state.hubPresenceLive = false;
  state.hubPresenceStaleUntil = d.scheduler.now() + hubPresenceStaleMs;
  console.info(stamp(`[mesh] hub presence stale hold_ms=${hubPresenceStaleMs}`));
  const handle = d.scheduler.interval(() => {
    handle.clear();
    if (state.hubPresenceDecay !== handle) return;
    state.hubPresenceDecay = null;
    state.hubPresenceStaleUntil = 0;
    if (state.hubPresenceLive || !state.lastNodeList) return;
    console.info(stamp('[mesh] hub presence decayed to peer reachability'));
    const reach = reachOf();
    for (const node of state.lastNodeList.nodes) {
      if (node.id === d.identity.nodeIdHex || !node.online) continue;
      if (isPeerReachable(reach.get(node.id))) continue;
      d.emitSyntheticOffline(node.id);
    }
  }, hubPresenceStaleMs);
  state.hubPresenceDecay = handle;
}
