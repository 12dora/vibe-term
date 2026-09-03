import type { UserKeyService } from '../auth';
import type { MeshHubRecord, MeshHubStore } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';
import { HUB_META_PEER_ID } from '../auth/user-store';
import { lookupSignedHubAuthorization, resolveMeshUserId } from '../hub/hub-authorization';
import { isRemoteNodePresent } from './mesh-agent-bridge';
import type { NodeEventProjection } from './node-event-dedupe';
import type { PeerReach, PeerTransportKind } from './types';
import { recordsFromNodeList } from './uplink-pool';
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

export type NodeListRejectPeerFn = (nodeId: string, alwaysDelete: boolean) => boolean;

export type NodeListApplyDeps = {
  state: {
    lastNodeList: UplinkNodeList | null;
    hubPresenceLive: boolean;
    hubGeneration: number;
    lastRtc: { stun: string[]; turn: unknown } | null;
  };
  identity: { nodeIdHex: string };
  hubStore: Pick<MeshHubStore, 'remove' | 'replaceAll' | 'list'>;
  scheduler: { now: () => number };
  userIdOf: () => string;
  userStore: UserStore;
  peerHolder: {
    manager?: {
      listReach: () => Map<string, PeerReach>;
      transportOf: (nodeId: string) => PeerTransportKind | null;
      rttOf: (nodeId: string) => number | null;
      notifyPeerEndpointsChanged: (nodeId: string) => void;
    } | null;
  };
  emitListNodeEvent: (event: NodeEventProjection) => void;
  opts: { onLocalNodeName?: (name: string) => void };
};

export function meshHubNotRetired(d: NodeListApplyDeps, hubNodeId: string): boolean {
  const uid = resolveMeshUserId(d.userStore, {
    nodeId: d.identity.nodeIdHex,
    explicit: d.userIdOf(),
  });
  return lookupSignedHubAuthorization(d.userStore, uid, hubNodeId)?.status !== 'retired';
}

export function listedHubNodeIds(list: UplinkNodeList): string[] {
  if (list.hubs && list.hubs.length > 0) return list.hubs.map((hub) => hub.nodeId);
  return list.hub?.nodeId ? [list.hub.nodeId] : [];
}

type HubWrite = Omit<MeshHubRecord, 'updatedAt'>;

function asHubWrite(row: MeshHubRecord): HubWrite {
  return {
    hubNodeId: row.hubNodeId,
    publicUrl: row.publicUrl,
    name: row.name,
    mode: row.mode,
    priority: row.priority,
    writerEpoch: row.writerEpoch,
    caFingerprint: row.caFingerprint,
    online: row.online,
    lastSeenAt: row.lastSeenAt,
  };
}

function localHubRowOutranks(own: HubWrite, incoming: HubWrite): boolean {
  if (own.writerEpoch !== incoming.writerEpoch) return own.writerEpoch > incoming.writerEpoch;
  return own.mode === 'active' && incoming.mode === 'standby';
}

function preferLocalHubRecords(d: NodeListApplyDeps, recs: HubWrite[]): HubWrite[] {
  const selfId = d.identity.nodeIdHex;
  const own = d.hubStore.list().find((row) => row.hubNodeId === selfId);
  if (!own) return recs;
  const ownWrite = asHubWrite(own);
  const idx = recs.findIndex((row) => row.hubNodeId === selfId);
  if (idx < 0) return [...recs, ownWrite];
  const incoming = recs[idx];
  if (!incoming || !localHubRowOutranks(ownWrite, incoming)) return recs;
  const next = recs.slice();
  next[idx] = ownWrite;
  return next;
}

export function reconcileHubStoreFromNodeList(d: NodeListApplyDeps, list: UplinkNodeList): void {
  const sourceId = list.writerHubId ?? list.hub?.nodeId ?? null;
  if (sourceId && !meshHubNotRetired(d, sourceId)) {
    d.hubStore.remove(sourceId);
  } else {
    const recs = preferLocalHubRecords(
      d,
      recordsFromNodeList(list).filter((row) => meshHubNotRetired(d, row.hubNodeId))
    );
    if (recs.length > 0) d.hubStore.replaceAll(recs, d.scheduler.now());
  }
  if (d.userIdOf()) {
    for (const row of d.hubStore.list()) {
      if (!meshHubNotRetired(d, row.hubNodeId)) d.hubStore.remove(row.hubNodeId);
    }
  }
}

export function emitListedNodeEvents(
  d: NodeListApplyDeps,
  list: UplinkNodeList,
  reach: Map<string, PeerReach>,
  rejectPeer: NodeListRejectPeerFn
): void {
  for (const node of list.nodes) {
    if (node.id === HUB_META_PEER_ID) continue;
    if (rejectPeer(node.id, true)) continue;
    d.emitListNodeEvent({
      nodeId: node.id,
      status: isRemoteNodePresent(node.online, reach.get(node.id)) ? 'online' : 'offline',
      reach: reach.get(node.id) ?? null,
      transport: d.peerHolder.manager?.transportOf(node.id) ?? null,
      rttMs: d.peerHolder.manager?.rttOf(node.id) ?? null,
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

export function emitUnlistedHubEvents(
  d: NodeListApplyDeps,
  list: UplinkNodeList,
  reach: Map<string, PeerReach>
): void {
  const emitHubIfUnlisted = (hubId: string, name?: string) => {
    if (
      hubId &&
      hubId !== d.identity.nodeIdHex &&
      hubId !== HUB_META_PEER_ID &&
      !list.nodes.some((node) => node.id === hubId)
    ) {
      const cert = d.userStore.getCert(hubId);
      const uid = d.userIdOf();
      if (cert && uid && cert.userId === uid && cert.revokedLogSeq == null) {
        d.emitListNodeEvent({
          nodeId: hubId,
          status: 'online',
          reach: reach.get(hubId) ?? null,
          transport: d.peerHolder.manager?.transportOf(hubId) ?? null,
          rttMs: d.peerHolder.manager?.rttOf(hubId) ?? null,
          name,
        });
      }
    }
  };
  if (list.hubs && list.hubs.length > 0) {
    for (const hub of list.hubs) emitHubIfUnlisted(hub.nodeId, hub.name);
  } else if (list.hub) {
    emitHubIfUnlisted(list.hub.nodeId, list.hub.name);
  }
}

export function pruneStaleListedPeers(
  d: NodeListApplyDeps,
  hubIds: ReadonlySet<string>,
  rejectPeer: NodeListRejectPeerFn
): void {
  for (const peer of d.userStore.listPeers()) {
    if (
      peer.nodeId === d.identity.nodeIdHex ||
      peer.nodeId === HUB_META_PEER_ID ||
      hubIds.has(peer.nodeId)
    ) {
      continue;
    }
    rejectPeer(peer.nodeId, false);
  }
}

export function applyUplinkNodeList(
  d: NodeListApplyDeps,
  list: UplinkNodeList,
  rejectPeer: NodeListRejectPeerFn
): void {
  const { state, identity } = d;
  state.lastNodeList = list;
  if (!state.hubPresenceLive) state.hubGeneration += 1;
  state.hubPresenceLive = true;
  state.lastRtc = { stun: list.rtc.stun, turn: list.rtc.turn ?? null };
  reconcileHubStoreFromNodeList(d, list);
  const reach = d.peerHolder.manager?.listReach() ?? new Map();
  const hubIds = new Set([
    ...listedHubNodeIds(list),
    ...d.hubStore.list().map((row) => row.hubNodeId),
  ]);
  emitListedNodeEvents(d, list, reach, rejectPeer);
  const selfListed = list.nodes.find((node) => node.id === identity.nodeIdHex);
  if (selfListed?.name) {
    try {
      d.opts.onLocalNodeName?.(selfListed.name);
    } catch {}
  }
  emitUnlistedHubEvents(d, list, reach);
  pruneStaleListedPeers(d, hubIds, rejectPeer);
}
