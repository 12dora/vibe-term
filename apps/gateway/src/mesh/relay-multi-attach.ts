import type { RelayQuota } from '@vibeterm/shared/relay';
import {
  mergeListedRtc,
  overlayOnlineUnion,
  unionListedNodes,
  withdrawListedRtc,
} from './node-list-apply';
import { getRelayDialBreaker } from './relay-dial-breaker';
import { relayListBoot } from './relay-node-list';
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
import {
  type RelayWiring,
  bindRelayAutoSelect,
  bindRelayMultiAttach,
  spawnRelayUplink,
} from './relay-wiring';
import type { InboundRelayHandler, MeshScheduler, UplinkState } from './types';
import type { UplinkClientOptions } from './uplink-client';
import type { UplinkPool } from './uplink-pool';
import { normalizeUplinkEndpointUrl, sameUplinkUrl } from './uplink-pool-url';
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
  listUplinkOnline(now: number): Set<string> | null;
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
  baseClient: Omit<UplinkClientOptions, 'uplinkUrl' | 'onNodeList'>;
  scheduler: MeshScheduler;
  onRelayStream: InboundRelayHandler;
  onExclusiveOffline: (peerIds: string[]) => void;
  rtc: RelayRtcHolder;
  noteStun?: () => void;
}): RelayMultiAttach {
  const presence = new RelayPresence();
  const staleMs = RELAY_PRESENCE_STALE_MS;
  let active = true;
  let stopSweep = () => {};
  const relayMode = () => input.wiring.secrets.uplinkKind() === 'relay';
  const emitExclusiveOffline = (peerIds: string[]): void => {
    markCachedNodesOffline(input.rtc, peerIds);
    input.onExclusiveOffline(peerIds);
  };
  const opener = openSecondaryAttach(input, presence, staleMs, emitExclusiveOffline);
  const live = () => active && relayMode();
  const api: RelayMultiAttach = {
    presence,
    opener,
    start() {
      active = true;
      opener.start();
      stopSweep = startPresenceSweep(input.scheduler, presence, emitExclusiveOffline);
      if (relayMode()) markPrimaryConnectedIfLive(input.uplink, presence, input.scheduler.now());
    },
    async stop() {
      active = false;
      stopSweep();
      stopSweep = () => {};
      await opener.stop();
    },
    reconcile: () => opener.reconcile(),
    handlePrimaryState(state, url, rttMs) {
      notePrimaryLink({
        input,
        presence,
        opener,
        staleMs,
        isLive: live(),
        state,
        url,
        rttMs,
      });
    },
    applyPrimaryList(list) {
      applyPrimaryRoster(input, presence, list);
    },
    listUplinkOnline(now) {
      if (input.wiring.secrets.uplinkKind() !== 'relay') return null;
      return presence.onlineUnion(now);
    },
    sendRtc: (peerId, sendPrimary, sendVia) =>
      sendRtcViaPresence(presence, opener, peerId, sendPrimary, sendVia),
    connectedClients: () => opener.connected(),
    secondaryClient: (url) => opener.client(url),
    prepareSwitch: async () => {},
    sendStatusAll: () => opener.sendStatusAll(),
    minMaxFileBytes: (primary) => minQuotaFileBytes(primary, opener.connected()),
  };
  bindPrimaryLifecycle({
    uplink: input.uplink,
    scheduler: input.scheduler,
    presence,
    opener,
    staleMs,
    isLive: live,
  });
  return api;
}

const PRESENCE_SWEEP_MS = 5_000;

function startPresenceSweep(
  scheduler: MeshScheduler,
  presence: RelayPresence,
  emit: (peerIds: string[]) => void
): () => void {
  const handle = scheduler.interval(() => {
    const exclusive = presence.sweep(scheduler.now());
    if (exclusive.length > 0) emit(exclusive);
  }, PRESENCE_SWEEP_MS);
  return () => handle.clear();
}

function notePrimaryLink(ctx: {
  input: Parameters<typeof createRelayMultiAttach>[0];
  presence: RelayPresence;
  opener: RelaySecondaryAttach;
  staleMs: number;
  isLive: boolean;
  state: UplinkState;
  url: string | null;
  rttMs: number | null;
}): void {
  if (!ctx.isLive || !ctx.url) return;
  const now = ctx.input.scheduler.now();
  if (ctx.state === 'online') {
    getRelayDialBreaker().reset();
    ctx.presence.setPrimary(ctx.url);
    ctx.presence.noteLink(ctx.url, true, ctx.rttMs, now, ctx.staleMs);
    void ctx.opener.reconcile();
    return;
  }
  if (primaryStillLive(ctx.input.uplink, ctx.url)) {
    void ctx.opener.reconcile();
    return;
  }
  ctx.presence.noteLink(ctx.url, false, null, now, ctx.staleMs);
  void ctx.opener.reconcile();
}

function primaryStillLive(uplink: UplinkPool, url: string): boolean {
  const live = uplink.liveClient();
  const attached = uplink.attachedUplink()?.publicUrl;
  return Boolean(live?.state === 'online' && attached && sameUplinkUrl(attached, url));
}

function applyPrimaryRoster(
  input: Parameters<typeof createRelayMultiAttach>[0],
  presence: RelayPresence,
  list: UplinkNodeList
): void {
  const url = input.uplink.attachedUplink()?.publicUrl;
  if (!url) return;
  presence.setPrimary(url);
  markPrimaryConnectedIfLive(input.uplink, presence, input.scheduler.now());
  presence.applyList(
    url,
    presencePeersFromList(list),
    list.version,
    input.scheduler.now(),
    relayListBoot(list)
  );
}

function openSecondaryAttach(
  input: Parameters<typeof createRelayMultiAttach>[0],
  presence: RelayPresence,
  staleMs: number,
  onExclusiveOffline: (peerIds: string[]) => void
): RelaySecondaryAttach {
  const opener = new RelaySecondaryAttach({
    rows: () =>
      input.wiring.secrets.relayRows().map((row) => ({
        url: row.url,
        priority: row.priority,
        kicked: row.kicked,
        credentialKey: input.wiring.secrets.credentialKeyFor?.(row.url) ?? '',
      })),
    primaryUrl: () => input.uplink.attachedUplink()?.publicUrl ?? null,
    excludeUrl: () => dialExcludeUrl(input.uplink),
    spawn: (url) =>
      input.spawn({
        ...input.baseClient,
        uplinkUrl: url,
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
  bindPoolRelayHooks(input.uplink, opener);
  return opener;
}

function dialExcludeUrl(uplink: UplinkPool): string | null {
  const attached = uplink.attachedUplink()?.publicUrl ?? null;
  const target = uplink.primaryTarget();
  if (!target || (attached && sameUplinkUrl(attached, target))) return null;
  return target;
}

function bindPoolRelayHooks(uplink: UplinkPool, opener: RelaySecondaryAttach): void {
  if (typeof uplink.setRelayHooks !== 'function') return;
  uplink.setRelayHooks({
    releaseSecondary: (url) => opener.release(url),
    takeoverSecondary: async (url) => {
      const client = await opener.detachOnline(url);
      if (!client) await opener.releaseNotOnline(url);
      return client as import('./types').PooledUplink | null;
    },
    adoptRetiring: (client) => opener.adoptOnline(client as unknown as SecondaryUplink),
    noteRetiring: (url) => opener.noteRetiring(url),
    clearRetiring: (url) => opener.clearRetiring(url),
    onTargetFree: () => {
      void opener.reconcile();
    },
    onNetworkReset: () => {
      opener.resetAttempts();
      getRelayDialBreaker().reset();
    },
  });
}

function mergeSecondaryRoster(
  presence: RelayPresence,
  rtc: RelayRtcHolder,
  url: string,
  list: UplinkNodeList,
  now: number
): void {
  presence.applyList(url, presencePeersFromList(list), list.version, now, relayListBoot(list));
  rtc.lastRtc = mergeListedRtc(rtc.lastRtc, list.rtc, {
    sourceUrl: normalizeUplinkEndpointUrl(url),
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
  const url = uplink.attachedUplink()?.publicUrl;
  const live = uplink.liveClient() as RelayUplinkClient | null;
  if (!url || live?.state !== 'online') return;
  presence.setPrimary(url);
  presence.noteLink(url, true, live && 'rttMs' in live ? live.rttMs : null, now);
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
}): void {
  input.uplink.onAttached((uplink) => {
    if (!input.isLive()) return;
    input.presence.setPrimary(uplink.publicUrl);
    const live = input.uplink.liveClient() as RelayUplinkClient | null;
    input.presence.noteLink(
      uplink.publicUrl,
      true,
      live && 'rttMs' in live ? live.rttMs : null,
      input.scheduler.now(),
      input.staleMs
    );
    void input.opener.reconcile();
  });
  input.uplink.onDetached(() => {
    if (!input.isLive()) return;
    const url = input.presence.primaryUrl();
    if (url) {
      input.presence.noteLink(url, false, null, input.scheduler.now(), input.staleMs);
    }
    input.presence.setPrimary(null);
    void input.opener.reconcile();
  });
}

export function withdrawRelayRtcOnDrop(rtc: RelayRtcHolder, url: string): void {
  rtc.lastRtc = withdrawListedRtc(rtc.lastRtc, normalizeUplinkEndpointUrl(url));
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
  bindRelayAutoSelect({
    wiring: input.wiring,
    uplink: input.uplink,
    attach,
    scheduler: input.scheduler,
  });
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
