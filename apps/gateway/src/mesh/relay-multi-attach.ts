import type { RelayQuota } from '@vibeterm/shared/relay';
import {
  mergeListedRtc,
  overlayOnlineUnion,
  unionListedNodes,
  withdrawListedRtc,
} from './node-list-apply';
import {
  RELAY_PRESENCE_STALE_MS,
  RelayPresence,
  type RelayPresencePeerInput,
} from './relay-presence';
import {
  RelaySecondaryAttach,
  type RelaySecondaryAttachOptions,
  type SecondaryUplink,
} from './relay-secondary-attach';
import type { RelayUplinkClient } from './relay-uplink-client';
import { type RelayWiring, bindRelayMultiAttach, spawnRelayUplink } from './relay-wiring';
import type { InboundRelayHandler, MeshScheduler, UplinkState } from './types';
import type { UplinkClientOptions } from './uplink-client';
import type { UplinkPool } from './uplink-pool';
import { normalizeHubEndpointUrl, sameHubUrl } from './uplink-pool-url';
import type { UplinkNodeList } from './uplink-protocol';

export type RelayRtcHolder = {
  lastRtc: { stun: string[]; turn: unknown } | null;
  lastNodeList: UplinkNodeList | null;
};

export type RelayMultiAttach = {
  presence: RelayPresence;
  opener: RelaySecondaryAttach;
  start(): void;
  stop(): Promise<void>;
  reconcile(): Promise<void>;
  handlePrimaryState(state: UplinkState, url: string | null, rttMs: number | null): void;
  applyPrimaryList(list: UplinkNodeList): void;
  listHubOnline(now: number): Set<string> | null;
  sendRtc(
    peerId: string,
    sendPrimary: () => void,
    sendVia: (client: SecondaryUplink) => void
  ): boolean;
  connectedClients(): SecondaryUplink[];
  secondaryClient(url: string): SecondaryUplink | null;
  prepareSwitch(url: string): Promise<void>;
  sendStatusAll(): void;
  minMaxFileBytes(primary: RelayQuota | null): RelayQuota | null;
};

export function presencePeersFromList(list: UplinkNodeList): RelayPresencePeerInput[] {
  return list.nodes.map((node) => {
    const extra = node as { rtt_ms?: unknown };
    return {
      id: node.id,
      online: node.online,
      rttMs: typeof extra.rtt_ms === 'number' ? extra.rtt_ms : null,
    };
  });
}

export function createRelayMultiAttach(input: {
  wiring: RelayWiring;
  uplink: UplinkPool;
  spawn: (opts: UplinkClientOptions) => SecondaryUplink;
  baseClient: Omit<UplinkClientOptions, 'hubUrl' | 'onNodeList'>;
  scheduler: MeshScheduler;
  onRelayStream: InboundRelayHandler;
  onExclusiveOffline: (peerIds: string[]) => void;
  rtc: RelayRtcHolder;
  noteStun?: () => void;
}): RelayMultiAttach {
  const presence = new RelayPresence();
  const decays = new Map<string, { clear: () => void }>();
  const staleMs = RELAY_PRESENCE_STALE_MS;
  let active = true;

  const relayMode = () => input.wiring.secrets.uplinkKind() === 'relay';

  const emitExclusiveOffline = (peerIds: string[]): void => {
    markCachedNodesOffline(input.rtc, peerIds);
    input.onExclusiveOffline(peerIds);
  };

  const opener = openSecondaryAttach(input, presence, staleMs, emitExclusiveOffline);

  function clearDecay(url: string): void {
    decays.get(url)?.clear();
    decays.delete(url);
  }

  function scheduleDecay(url: string): void {
    if (!active || !relayMode()) return;
    clearDecay(url);
    const handle = input.scheduler.interval(() => {
      handle.clear();
      decays.delete(url);
      const exclusive = presence.decay(url, input.scheduler.now());
      if (exclusive.length > 0) emitExclusiveOffline(exclusive);
    }, staleMs);
    decays.set(url, handle);
  }

  const api: RelayMultiAttach = {
    presence,
    opener,
    start() {
      active = true;
      opener.start();
      if (relayMode()) markPrimaryConnectedIfLive(input.uplink, presence, input.scheduler.now());
    },
    async stop() {
      active = false;
      for (const handle of decays.values()) handle.clear();
      decays.clear();
      await opener.stop();
    },
    reconcile: () => opener.reconcile(),
    handlePrimaryState(state, url, rttMs) {
      if (!active || !relayMode() || !url) return;
      const now = input.scheduler.now();
      if (state === 'online') {
        clearDecay(url);
        presence.setPrimary(url);
        presence.setConnected(url, true, rttMs, now);
        void opener.reconcile();
        return;
      }
      // path-rerace 等瞬态非 online：live 仍挂同一 hub 时不要把花名册 connected 打掉。
      const live = input.uplink.liveClient();
      const attached = input.uplink.attachedHub()?.publicUrl;
      if (live?.state === 'online' && attached && sameHubUrl(attached, url)) {
        void opener.reconcile();
        return;
      }
      presence.markDisconnected(url, now, staleMs);
      scheduleDecay(url);
      void opener.reconcile();
    },
    applyPrimaryList(list) {
      const url = input.uplink.attachedHub()?.publicUrl;
      if (!url) return;
      presence.setPrimary(url);
      markPrimaryConnectedIfLive(input.uplink, presence, input.scheduler.now());
      presence.applyList(url, presencePeersFromList(list), list.version, input.scheduler.now());
    },
    listHubOnline(now) {
      if (input.wiring.secrets.uplinkKind() !== 'relay') return null;
      return presence.onlineUnion(now);
    },
    sendRtc: (peerId, sendPrimary, sendVia) =>
      sendRtcViaPresence(presence, opener, peerId, sendPrimary, sendVia),
    connectedClients: () => opener.connected(),
    secondaryClient: (url) => opener.client(url),
    prepareSwitch: (url) => opener.release(url),
    sendStatusAll: () => opener.sendStatusAll(),
    minMaxFileBytes: (primary) => minQuotaFileBytes(primary, opener.connected()),
  };

  bindPrimaryLifecycle({
    uplink: input.uplink,
    scheduler: input.scheduler,
    presence,
    opener,
    staleMs,
    isLive: () => active && relayMode(),
    scheduleDecay,
  });

  return api;
}

function openSecondaryAttach(
  input: Parameters<typeof createRelayMultiAttach>[0],
  presence: RelayPresence,
  staleMs: number,
  onExclusiveOffline: (peerIds: string[]) => void
): RelaySecondaryAttach {
  return new RelaySecondaryAttach({
    rows: () =>
      input.wiring.secrets.relayRows().map((row) => ({
        url: row.url,
        priority: row.priority,
        kicked: row.kicked,
        credentialKey: input.wiring.secrets.credentialKeyFor?.(row.url) ?? '',
      })),
    primaryUrl: () => input.uplink.attachedHub()?.publicUrl ?? presence.primaryUrl(),
    spawn: (url) =>
      input.spawn({
        ...input.baseClient,
        hubUrl: url,
        keyLogCatchUp: 'prefix-verified',
        onNodeList: (list) => {
          mergeSecondaryRoster(presence, input.rtc, url, list, input.scheduler.now());
          input.noteStun?.();
        },
      }),
    presence,
    scheduler: input.scheduler,
    openPrimary: (peer) => input.uplink.openRelay(peer),
    onRelayStream: input.onRelayStream,
    onExclusiveOffline,
    staleMs,
  } satisfies RelaySecondaryAttachOptions);
}

function mergeSecondaryRoster(
  presence: RelayPresence,
  rtc: RelayRtcHolder,
  url: string,
  list: UplinkNodeList,
  now: number
): void {
  presence.applyList(url, presencePeersFromList(list), list.version, now);
  rtc.lastRtc = mergeListedRtc(rtc.lastRtc, list.rtc, {
    sourceUrl: normalizeHubEndpointUrl(url),
    primary: false,
  });
  const unioned = rtc.lastNodeList
    ? unionListedNodes(rtc.lastNodeList.nodes, list.nodes)
    : list.nodes;
  const primaryUrl = presence.primaryUrl();
  const primaryIds = primaryUrl ? presence.listedPeerIds(primaryUrl) : [];
  const nodes = overlayOnlineUnion(unioned, presence.onlineUnion(now), primaryIds);
  rtc.lastNodeList = rtc.lastNodeList ? { ...rtc.lastNodeList, nodes } : { ...list, nodes };
}

function markPrimaryConnectedIfLive(
  uplink: UplinkPool,
  presence: RelayPresence,
  now: number
): void {
  const url = uplink.attachedHub()?.publicUrl;
  const live = uplink.liveClient() as RelayUplinkClient | null;
  if (!url || live?.state !== 'online') return;
  presence.setPrimary(url);
  presence.setConnected(url, true, live && 'rttMs' in live ? live.rttMs : null, now);
}

function sendRtcViaPresence(
  presence: RelayPresence,
  opener: RelaySecondaryAttach,
  peerId: string,
  sendPrimary: () => void,
  sendVia: (client: SecondaryUplink) => void
): boolean {
  const primary = presence.primaryUrl();
  const chosen = presence.relaysFor(peerId)[0] ?? primary;
  const client = chosen && !(primary && chosen === primary) ? opener.client(chosen) : null;
  if (client?.state === 'online') {
    sendVia(client);
    return true;
  }
  sendPrimary();
  return true;
}

export function minQuotaFileBytes(
  primary: RelayQuota | null,
  connected: readonly { quota: RelayQuota | null }[]
): RelayQuota | null {
  const quotas = [primary, ...connected.map((client) => client.quota)].filter(
    (quota): quota is RelayQuota => quota != null
  );
  const caps = quotas
    .map((quota) => quota.maxFileBytes)
    .filter((n): n is number => typeof n === 'number' && n >= 0);
  if (caps.length === 0) return primary;
  const maxFileBytes = Math.min(...caps);
  if (primary) return { ...primary, maxFileBytes };
  const source = quotas.find((quota) => quota.maxFileBytes === maxFileBytes) ?? quotas[0];
  return { ...source, maxFileBytes };
}

function bindPrimaryLifecycle(input: {
  uplink: UplinkPool;
  scheduler: MeshScheduler;
  presence: RelayPresence;
  opener: RelaySecondaryAttach;
  staleMs: number;
  isLive: () => boolean;
  scheduleDecay: (url: string) => void;
}): void {
  input.uplink.onAttached((hub) => {
    if (!input.isLive()) return;
    input.presence.setPrimary(hub.publicUrl);
    const live = input.uplink.liveClient() as RelayUplinkClient | null;
    input.presence.setConnected(
      hub.publicUrl,
      true,
      live && 'rttMs' in live ? live.rttMs : null,
      input.scheduler.now()
    );
    void input.opener.reconcile();
  });
  input.uplink.onDetached(() => {
    if (!input.isLive()) return;
    const url = input.presence.primaryUrl();
    if (url) {
      input.presence.markDisconnected(url, input.scheduler.now(), input.staleMs);
      input.scheduleDecay(url);
    }
    void input.opener.reconcile();
  });
}

export function withdrawRelayRtcOnDrop(rtc: RelayRtcHolder, url: string): void {
  rtc.lastRtc = withdrawListedRtc(rtc.lastRtc, normalizeHubEndpointUrl(url));
}

/** secondary/primary decay 到期：缓存清单里只经该中继在线的节点立刻落 offline。 */
export function markCachedNodesOffline(rtc: RelayRtcHolder, peerIds: readonly string[]): void {
  const list = rtc.lastNodeList;
  if (!list || peerIds.length === 0) return;
  const drop = new Set(peerIds);
  let changed = false;
  const nodes = list.nodes.map((node) => {
    if (!drop.has(node.id) || !node.online) return node;
    changed = true;
    return { ...node, online: false };
  });
  if (changed) rtc.lastNodeList = { ...list, nodes };
}

export function installRelayMultiAttach(input: {
  wiring: RelayWiring;
  uplink: UplinkPool;
  peerBind: {
    bindRelayPresence(presence: RelayPresence, opener: RelaySecondaryAttach): void;
    acceptInboundRelay(
      stream: import('@vibeterm/shared/link').LinkStream,
      from: string,
      viaRelay?: string
    ): void;
  };
  userId: () => string;
  keyLogApplier: UplinkClientOptions['keyLogApplier'];
  userStore: UplinkClientOptions['userStore'];
  statusProvider: UplinkClientOptions['statusProvider'];
  scheduler: MeshScheduler;
  wsFactory?: UplinkClientOptions['wsFactory'];
  pingIntervalMs?: number;
  onRtcSignal: NonNullable<UplinkClientOptions['onRtcSignal']>;
  onExclusiveOffline: (peerIds: string[]) => void;
  rtc: RelayRtcHolder;
  noteStun: () => void;
}): RelayMultiAttach | null {
  let attach: RelayMultiAttach;
  try {
    attach = createRelayMultiAttach({
      wiring: input.wiring,
      uplink: input.uplink,
      spawn: (opts) => spawnRelayUplink(input.wiring, opts) as never,
      baseClient: {
        identity: input.uplink.identity,
        userId: input.userId,
        keyLogApplier: input.keyLogApplier,
        userStore: input.userStore,
        statusProvider: input.statusProvider,
        scheduler: input.scheduler,
        ...(input.wsFactory ? { wsFactory: input.wsFactory } : {}),
        ...(input.pingIntervalMs !== undefined ? { pingIntervalMs: input.pingIntervalMs } : {}),
        onRtcSignal: input.onRtcSignal,
      },
      scheduler: input.scheduler,
      onRelayStream: (stream, from, viaRelay) =>
        input.peerBind.acceptInboundRelay(stream, from, viaRelay),
      onExclusiveOffline: input.onExclusiveOffline,
      rtc: input.rtc,
      noteStun: input.noteStun,
    });
  } catch {
    return null;
  }
  bindRelayMultiAttach(input.wiring, attach);
  input.peerBind.bindRelayPresence(attach.presence, attach.opener);
  return attach;
}

export function primaryNodeListApplyPatch(
  attach: RelayMultiAttach | null,
  lastNodes: UplinkNodeList['nodes'],
  incoming: UplinkNodeList
) {
  attach?.applyPrimaryList(incoming);
  return {
    rtcSourceUrl: attach?.presence.primaryUrl() ?? null,
    retainPeerIds: () => attach?.presence.knownPeerIds() ?? [],
    extraListedNodes: () => {
      if (!attach) return [];
      const known = attach.presence.knownPeerIds();
      const online = attach.presence.onlineUnion();
      const have = new Set(incoming.nodes.map((row) => row.id));
      return lastNodes
        .filter((node) => !have.has(node.id) && known.has(node.id))
        .map((node) => {
          const isOnline = online.has(node.id);
          return node.online === isOnline ? node : { ...node, online: isOnline };
        });
    },
    onlineUnionIds: () => attach?.presence.onlineUnion() ?? [],
  };
}
