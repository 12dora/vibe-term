import type { UserKeyService } from '../auth';
import { LEGACY_HUB_PEER_ID, type UserStore } from '../auth/user-store';
import { isRemoteNodePresent } from './mesh-agent-bridge';
import type { NodeEventProjection } from './node-event-dedupe';
import type { PeerReach, PeerTransportKind } from './types';
import { persistUplinkPeerCache } from './uplink-peer-persist';
import type { UplinkNodeList } from './uplink-protocol';

export const STATUS_IFACE_CACHE_TTL_MS = 8_000;

export function createTtlCache<T>(
  read: () => T,
  ttlMs = STATUS_IFACE_CACHE_TTL_MS,
  now: () => number = Date.now
): { get: () => T; refresh: () => T; invalidate: () => void } {
  let value: T | undefined;
  let at = Number.NEGATIVE_INFINITY;
  let has = false;
  const refresh = (): T => {
    value = read();
    at = now();
    has = true;
    return value;
  };
  return {
    get() {
      if (has && now() - at < ttlMs) return value as T;
      return refresh();
    },
    refresh,
    invalidate() {
      has = false;
      at = Number.NEGATIVE_INFINITY;
    },
  };
}

export function attachKeyLogHeadNotify(
  apply: UserKeyService['apply'],
  notify: () => void
): UserKeyService['apply'] {
  return async (userId, input) => {
    const result = await apply(userId, input);
    if (result.ok) notify();
    return result;
  };
}

export type ListedRtcConfig = { stun: string[]; turn: unknown };

export type RelayTurnEntry = { url: string; username: string; credential: string };

export type MergeListedRtcOpts = {
  /** 有值时按中继 URL 合并 TURN/STUN；缺省仍是整表覆盖。 */
  sourceUrl?: string;
  primary?: boolean;
};

type RtcSourceBag = {
  primaryUrl: string | null;
  byUrl: Map<string, { stun: string[]; turn: RelayTurnEntry | null }>;
};

const rtcSources = new WeakMap<object, RtcSourceBag>();

function parseRelayTurn(turn: unknown): RelayTurnEntry | null {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return null;
  const rec = turn as Record<string, unknown>;
  const url =
    typeof rec.url === 'string'
      ? rec.url
      : Array.isArray(rec.urls) && typeof rec.urls[0] === 'string'
        ? rec.urls[0]
        : null;
  if (!url) return null;
  if (typeof rec.username !== 'string' || typeof rec.credential !== 'string') return null;
  return { url, username: rec.username, credential: rec.credential };
}

function composeRelayRtc(bag: RtcSourceBag): ListedRtcConfig {
  const order: string[] = [];
  if (bag.primaryUrl && bag.byUrl.has(bag.primaryUrl)) order.push(bag.primaryUrl);
  for (const url of bag.byUrl.keys()) {
    if (url !== bag.primaryUrl) order.push(url);
  }
  const stun: string[] = [];
  const seenStun = new Set<string>();
  for (const url of order) {
    for (const item of bag.byUrl.get(url)?.stun ?? []) {
      if (seenStun.has(item)) continue;
      seenStun.add(item);
      stun.push(item);
    }
  }
  const turn: RelayTurnEntry[] = [];
  const seenTurn = new Set<string>();
  for (const url of order) {
    const entry = bag.byUrl.get(url)?.turn;
    if (!entry) continue;
    const key = `${entry.url}\0${entry.username}\0${entry.credential}`;
    if (seenTurn.has(key)) continue;
    seenTurn.add(key);
    turn.push(entry);
  }
  return { stun, turn: turn.length > 0 ? turn : null };
}

/** 记下中继下发的 STUN（空列表表示没有自定义列表）；TURN 始终采用下发值。 */
export function mergeListedRtc(
  prev: ListedRtcConfig | null,
  listed: { stun: string[]; turn?: unknown },
  opts?: MergeListedRtcOpts
): ListedRtcConfig {
  if (!opts?.sourceUrl) {
    return {
      stun: [...listed.stun],
      turn: listed.turn ?? null,
    };
  }
  const prevBag = prev ? rtcSources.get(prev) : undefined;
  const byUrl = new Map(prevBag?.byUrl ?? []);
  let primaryUrl = prevBag?.primaryUrl ?? null;
  if (opts.primary) primaryUrl = opts.sourceUrl;
  byUrl.set(opts.sourceUrl, { stun: [...listed.stun], turn: parseRelayTurn(listed.turn) });
  const bag: RtcSourceBag = { primaryUrl, byUrl };
  const next = composeRelayRtc(bag);
  rtcSources.set(next, bag);
  return next;
}

/** 某台中继断开或撤回 TURN 时只删它自己的条目。 */
export function withdrawListedRtc(
  prev: ListedRtcConfig | null,
  sourceUrl: string
): ListedRtcConfig | null {
  if (!prev) return prev;
  const bag = rtcSources.get(prev);
  if (!bag?.byUrl.has(sourceUrl)) return prev;
  const byUrl = new Map(bag.byUrl);
  byUrl.delete(sourceUrl);
  const nextBag: RtcSourceBag = {
    primaryUrl: bag.primaryUrl === sourceUrl ? null : bag.primaryUrl,
    byUrl,
  };
  const next = composeRelayRtc(nextBag);
  rtcSources.set(next, nextBag);
  return next;
}

export type NodeListRejectPeerFn = (nodeId: string, alwaysDelete: boolean) => boolean;

export type NodeListApplyDeps = {
  state: {
    lastNodeList: UplinkNodeList | null;
    uplinkPresenceLive?: boolean;
    uplinkGeneration: number;
    lastRtc: { stun: string[]; turn: unknown } | null;
  };
  /** 中继 URL：primary 清单按此合并 TURN/STUN，而不是覆盖。 */
  rtcSourceUrl?: string | null;
  retainPeerIds?: () => Iterable<string>;
  extraListedNodes?: () => UplinkNodeList['nodes'];
  /** 多中继在线并集：primary 标 offline 但 secondary 仍在线的节点按 online 应用。 */
  onlineUnionIds?: () => Iterable<string>;
  identity: { nodeIdHex: string };
  scheduler: { now: () => number };
  userIdOf: () => string;
  userStore: UserStore;
  peerHolder: {
    manager?: {
      listReach: () => Map<string, PeerReach>;
      transportOf: (nodeId: string) => PeerTransportKind | null;
      rttOf: (nodeId: string) => number | null;
      viaRelayOf?: (nodeId: string) => string | null;
      relayPresenceOf?: (nodeId: string) => string[] | undefined;
      notifyPeerEndpointsChanged: (nodeId: string) => void;
    } | null;
  };
  emitListNodeEvent: (event: NodeEventProjection) => void;
  opts: { onLocalNodeName?: (name: string) => void };
};

export function emitListedNodeEvents(
  d: NodeListApplyDeps,
  list: UplinkNodeList,
  reach: Map<string, PeerReach>,
  rejectPeer: NodeListRejectPeerFn
): void {
  for (const node of list.nodes) {
    if (node.id === LEGACY_HUB_PEER_ID) continue;
    if (rejectPeer(node.id, true)) continue;
    d.emitListNodeEvent({
      nodeId: node.id,
      status: isRemoteNodePresent(node.online, reach.get(node.id)) ? 'online' : 'offline',
      reach: reach.get(node.id) ?? null,
      ...listedLinkFields(d, node.id),
      inventory:
        typeof node.inventory === 'string'
          ? node.inventory
          : JSON.stringify(node.inventory ?? null),
      version: node.version,
      direct_capable: node.direct_capable,
      name: node.name,
    });
    if (node.id !== d.identity.nodeIdHex) d.peerHolder.manager?.notifyPeerEndpointsChanged(node.id);
  }
}

export function emitRenameNodeEvent(d: NodeListApplyDeps, nodeId: string, name: string): void {
  const listed = d.state.lastNodeList?.nodes.find((node) => node.id === nodeId);
  const reach = d.peerHolder.manager?.listReach().get(nodeId) ?? null;
  const online = listed
    ? isRemoteNodePresent(listed.online, reach)
    : nodeId === d.identity.nodeIdHex;
  d.emitListNodeEvent({
    nodeId,
    status: online ? 'online' : 'offline',
    reach,
    ...listedLinkFields(d, nodeId),
    inventory:
      listed?.inventory == null
        ? undefined
        : typeof listed.inventory === 'string'
          ? listed.inventory
          : JSON.stringify(listed.inventory),
    version: listed?.version,
    direct_capable: listed?.direct_capable,
    name,
  });
  if (nodeId === d.identity.nodeIdHex) {
    try {
      d.opts.onLocalNodeName?.(name);
    } catch {}
  }
}

export function pruneStaleListedPeers(
  d: NodeListApplyDeps,
  rejectPeer: NodeListRejectPeerFn
): void {
  const retain = new Set(d.retainPeerIds?.() ?? []);
  for (const peer of d.userStore.listPeers()) {
    if (
      peer.nodeId === d.identity.nodeIdHex ||
      peer.nodeId === LEGACY_HUB_PEER_ID ||
      retain.has(peer.nodeId)
    ) {
      continue;
    }
    rejectPeer(peer.nodeId, false);
  }
}

function listedLinkFields(d: NodeListApplyDeps, nodeId: string) {
  return {
    transport: d.peerHolder.manager?.transportOf(nodeId) ?? null,
    rttMs: d.peerHolder.manager?.rttOf(nodeId) ?? null,
    viaRelay: d.peerHolder.manager?.viaRelayOf?.(nodeId) ?? null,
    relayPresence: d.peerHolder.manager?.relayPresenceOf?.(nodeId),
  };
}

export function unionListedNodes(
  primary: UplinkNodeList['nodes'],
  extra: UplinkNodeList['nodes']
): UplinkNodeList['nodes'] {
  if (extra.length === 0) return primary;
  const have = new Set(primary.map((node) => node.id));
  const added = extra.filter((node) => !have.has(node.id));
  return added.length === 0 ? primary : [...primary, ...added];
}

/**
 * 并集内的节点强制 online。retained（不在 primary 清单）且不在并集的节点强制 offline，
 * 避免 secondary decay 后仍被缓存清单复活。primary 清单保留自身标志，除非并集报 online。
 */
export function overlayOnlineUnion(
  nodes: UplinkNodeList['nodes'],
  onlineIds: Iterable<string>,
  primaryIds?: Iterable<string>
): UplinkNodeList['nodes'] {
  const online = onlineIds instanceof Set ? onlineIds : new Set(onlineIds);
  const primary =
    primaryIds == null ? null : primaryIds instanceof Set ? primaryIds : new Set(primaryIds);
  let changed = false;
  const next = nodes.map((node) => {
    if (online.has(node.id)) {
      if (node.online) return node;
      changed = true;
      return { ...node, online: true };
    }
    if (primary && !primary.has(node.id) && node.online) {
      changed = true;
      return { ...node, online: false };
    }
    return node;
  });
  return changed ? next : nodes;
}

export function mergeAppliedNodeList(
  list: UplinkNodeList,
  extras: UplinkNodeList['nodes'],
  onlineIds?: Iterable<string>
): UplinkNodeList {
  const unioned = extras.length > 0 ? unionListedNodes(list.nodes, extras) : list.nodes;
  const nodes = onlineIds
    ? overlayOnlineUnion(
        unioned,
        onlineIds,
        list.nodes.map((node) => node.id)
      )
    : unioned;
  return nodes === list.nodes ? list : { ...list, nodes };
}

export function applyUplinkNodeList(
  d: NodeListApplyDeps,
  list: UplinkNodeList,
  rejectPeer: NodeListRejectPeerFn
): void {
  const { state, identity } = d;
  const applied = mergeAppliedNodeList(list, d.extraListedNodes?.() ?? [], d.onlineUnionIds?.());
  state.lastNodeList = applied;
  if (!state.uplinkPresenceLive) state.uplinkGeneration += 1;
  state.uplinkPresenceLive = true;
  state.lastRtc = mergeListedRtc(
    state.lastRtc,
    list.rtc,
    d.rtcSourceUrl ? { sourceUrl: d.rtcSourceUrl, primary: true } : undefined
  );
  persistUplinkPeerCache({
    userStore: d.userStore,
    userId: d.userIdOf(),
    selfNodeId: identity.nodeIdHex,
    list: applied,
    now: d.scheduler.now(),
  });
  const reach = d.peerHolder.manager?.listReach() ?? new Map();
  emitListedNodeEvents(d, applied, reach, rejectPeer);
  const selfListed = applied.nodes.find((node) => node.id === identity.nodeIdHex);
  if (selfListed?.name) {
    try {
      d.opts.onLocalNodeName?.(selfListed.name);
    } catch {}
  }
  pruneStaleListedPeers(d, rejectPeer);
}
