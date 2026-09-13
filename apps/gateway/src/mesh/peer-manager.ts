import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { RtcSignalMessage } from './mesh-deps';
import {
  type PeerLinkPurpose,
  bindPausedPeerDrop,
  isNodePaused,
  peerDialRetireOf,
  retirePeerDialState,
} from './node-pause';
import { type PeerCtlHost, handlePeerCtl, receiveRtcSignal } from './peer-ctl';
import type { DcRerollCoordinator } from './peer-dc-reroll';
import { type DcUpgradeCoordinator, PeerCollaboratorHost } from './peer-dc-upgrade';
import type { PeerDialer } from './peer-dialer';
import { winningDialInitiator } from './peer-direct-attempt';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { getPeerLink } from './peer-get-link';
import { type PeerLifecycleHost, startPeerManager, stopPeerManager } from './peer-lifecycle';
import type { PeerLinkDrain } from './peer-link-drain';
import type { PeerLinkWaiters } from './peer-link-waiters';
import type { PeerLiveRegistry } from './peer-live-registry';
import { type PeerManagerState, createPeerManagerState, isPeerTrusted } from './peer-manager-state';
import type { PeerLinkDetail, PeerManagerOptions } from './peer-manager-types';
import {
  listPeerReach,
  liveSessionOf,
  peerLinkDetailFromState,
  relayPresenceOfIndex,
  requirePeerAdmitted,
  viaRelayOfLive,
} from './peer-path-view';
import type { LivePeer } from './peer-reconnect-wake';
import type { PeerUpgradeOpts, RtcSignalInboxEntry, RtcWakeGate } from './peer-rtc-wake';
import type { PeerServer } from './peer-server';
import type { PeerStatusSync } from './peer-status-sync';
import { createPeerCollaborators, wrapPeerScheduler } from './peer-wire';
import type { RelayPresenceIndex, RelayStreamOpener } from './relay-presence-types';
import type { RouteDegradeCoordinator } from './route-degrade';
import type { DispatchHttp, MeshIdentity, PeerReach, PeerTransportKind } from './types';

export {
  KEY_LOG_STATUS_DEBOUNCE_MS,
  PEER_CONNECT_TIMEOUT_MS,
  PEER_IDLE_MS,
  PEER_LAN_DIAL_TIMEOUT_MS,
  PEER_MAX_CONCURRENT_STREAMS,
  PEER_MISSED_PONG_LIMIT,
  PEER_PING_INTERVAL_MS,
  PEER_RETIRE_MAX_MS,
  PEER_RETIRE_MIN_MS,
  PEER_RETIRE_QUIET_MS,
  PEER_TRANSPORT_RANK,
  PEER_WS_DIAL_STAGGER_MS,
  RTC_PEER_INBOX_MAX_MESSAGES,
  comparePeerTransport,
} from './peer-manager-state';
export {
  PEER_DC_UPGRADE_RETRY_DELAYS_MS,
  PEER_DC_UPGRADE_RETRY_TAIL_MS,
  PEER_MAX_ENDPOINT_LENGTH,
  PEER_MAX_ENDPOINTS,
  PEER_UPGRADE_BACKOFF_CAP_MS,
  PEER_UPGRADE_COOLDOWN_MS,
  PEER_UPGRADE_MAX_INFLIGHT,
  PEER_UPGRADE_SCAN_MS,
} from './peer-dc-upgrade';
export {
  PEER_RTC_WAKE_COOLDOWN_MS,
  PEER_RTC_WAKE_NONCE_CACHE,
  PEER_RTC_WAKE_VERIFY_BURST,
  PEER_RTC_WAKE_VERIFY_WINDOW_MS,
  RTC_SIGNAL_INBOX_TTL_MS,
} from './peer-rtc-wake';
export { winningDialInitiator };
export type { PeerLinkDetail, PeerLinkFactory, PeerManagerOptions } from './peer-manager-types';

export class PeerManager extends PeerCollaboratorHost {
  readonly identity: MeshIdentity;
  private readonly state: PeerManagerState;
  private readonly dialer: PeerDialer;
  private readonly registry: PeerLiveRegistry;
  private readonly drain: PeerLinkDrain;
  private readonly waiters: PeerLinkWaiters;
  private readonly statusSync: PeerStatusSync;
  private readonly hubHostOf: () => string | null;
  private readonly rtcListeners = new Map<string, Set<(msg: RtcSignalMessage) => void>>();
  private readonly rtcInbox: Map<string, RtcSignalInboxEntry[]>;
  private readonly onBrowserSignal: ((msg: RtcSignalMessage, fromNodeId?: string) => void) | null;
  private readonly ensureDcSession: ((peerNodeId: string, rtcSession: string) => void) | null;
  private readonly server: PeerServer | null;
  private dispatchHttp?: DispatchHttp;
  protected readonly dcUpgrade: DcUpgradeCoordinator;
  protected readonly rtcWake: RtcWakeGate;
  private readonly reroll: DcRerollCoordinator;
  private readonly routes: RouteDegradeCoordinator;

  constructor(opts: PeerManagerOptions) {
    super();
    const scheduler = wrapPeerScheduler(opts);
    this.state = createPeerManagerState({
      identity: opts.identity,
      userStore: opts.userStore,
      uplink: opts.uplink,
      scheduler,
      endpointBackoff:
        opts.endpointBackoff ?? new PeerEndpointBackoff({ now: () => scheduler.now() }),
    });
    this.identity = opts.identity;
    this.rtcInbox = this.state.rtcInbox;
    this.onBrowserSignal = opts.onBrowserSignal ?? null;
    this.ensureDcSession = opts.ensureDcSession ?? null;
    this.dispatchHttp = opts.dispatchHttp;
    const hubHost = opts.hubHost;
    this.hubHostOf = typeof hubHost === 'function' ? hubHost : () => hubHost ?? null;
    const parts = createPeerCollaborators({
      opts,
      state: this.state,
      identity: this.identity,
      scheduler,
      rtcListeners: this.rtcListeners,
      dispatchHttp: () => this.dispatchHttp,
      ensureDcSession: this.ensureDcSession,
      hooks: this.wireHooks(),
    });
    this.routes = parts.routes;
    this.dcUpgrade = parts.dcUpgrade;
    this.rtcWake = parts.rtcWake;
    this.statusSync = parts.statusSync;
    this.waiters = parts.waiters;
    this.drain = parts.drain;
    this.reroll = parts.reroll;
    this.registry = parts.registry;
    this.dialer = parts.dialer;
    this.server = parts.server;
    bindPausedPeerDrop((nodeId) => this.dropPausedPeer(nodeId));
  }

  private wireHooks() {
    return {
      maybeUpgrade: (nodeId: string, upgradeOpts: PeerUpgradeOpts) =>
        this.maybeUpgrade(nodeId, upgradeOpts),
      requireTrusted: (nodeId: string) => this.requireTrusted(nodeId),
      isTrusted: (nodeId: string) => this.isTrusted(nodeId),
      getLink: (nodeId: string) => this.getLink(nodeId),
      handlePeerCtl: (live: LivePeer, bytes: Uint8Array) => this.handlePeerCtl(live, bytes),
      notifyPeerEndpointsChanged: (nodeId?: string) => this.notifyPeerEndpointsChanged(nodeId),
      wantsUpgrade: (live: LivePeer) => this.wantsUpgrade(live),
      nextDcAttemptId: () => this.nextDcAttemptId(),
      armDcHealthTimer: (nodeId: string, attemptId: string) =>
        this.armDcHealthTimer(nodeId, attemptId),
      cancelDcHealthTimer: (nodeId: string) => this.cancelDcHealthTimer(nodeId),
      armDcUpgradeRetry: (nodeId: string) => this.armDcUpgradeRetry(nodeId),
      cancelDcUpgradeRetry: (nodeId: string) => this.cancelDcUpgradeRetry(nodeId),
      ensureGate: (nodeId: string) => this.ensureGate(nodeId),
      ensureIncomingWakeGate: (nodeId: string) => this.ensureIncomingWakeGate(nodeId),
      dispatchRtcWake: (peerNodeId: string) => this.dispatchRtcWake(peerNodeId),
      releaseRtcWakeAttempt: (peerNodeId: string) => this.releaseRtcWakeAttempt(peerNodeId),
      signalingFor: (peerNodeId: string) => this.signalingFor(peerNodeId),
    };
  }

  private ctlHost(): PeerCtlHost {
    return {
      identity: this.identity,
      state: this.state,
      statusSync: this.statusSync,
      registry: this.registry,
      drain: this.drain,
      dialer: this.dialer,
      reroll: this.reroll,
      dcUpgrade: this.dcUpgrade,
      rtcListeners: this.rtcListeners,
      onBrowserSignal: this.onBrowserSignal,
      isTrusted: this.isTrusted,
      maybeUpgrade: (nodeId, upgradeOpts) => this.maybeUpgrade(nodeId, upgradeOpts),
      handleIncomingRtcWake: (fromNodeId, msg) => this.handleIncomingRtcWake(fromNodeId, msg),
    };
  }

  private lifecycleHost(): PeerLifecycleHost {
    return {
      state: this.state,
      server: this.server,
      dialer: this.dialer,
      dcUpgrade: this.dcUpgrade,
      statusSync: this.statusSync,
      drain: this.drain,
      registry: this.registry,
      rtcWake: this.rtcWake,
      routes: this.routes,
      rtcListeners: this.rtcListeners,
      refreshAdvertisedStatus: () => this.refreshAdvertisedStatus(),
      notifyPeerEndpointsChanged: (nodeId) => this.notifyPeerEndpointsChanged(nodeId),
    };
  }

  private get dcBreaker() {
    return this.dcUpgrade.dcBreaker;
  }
  get listenPort(): number | null {
    return this.server?.listening ? this.server.port : null;
  }
  bindRelayPresence(presence: RelayPresenceIndex, opener: RelayStreamOpener): void {
    this.state.relayPresence = presence;
    this.state.relayOpener = opener;
  }

  acceptInboundRelay(stream: LinkStream, fromNodeId: string, viaRelay?: string): void {
    void this.dialer.acceptRelay(stream, fromNodeId, viaRelay);
  }
  quiesceCapableOf(nodeId: string): boolean {
    return this.state.live.get(nodeId)?.quiesceCapable === true;
  }
  dropPausedPeer(nodeId: string): void {
    retirePeerDialState(peerDialRetireOf(this), nodeId, 'paused');
  }

  async start(): Promise<void> {
    await startPeerManager(this.lifecycleHost());
  }

  async stop(): Promise<void> {
    await stopPeerManager(this.lifecycleHost());
  }

  getLive(nodeId: string): LinkSession | null {
    return liveSessionOf(this.state, nodeId, (id) => this.onRevoked(id));
  }
  transportOf(n: string): PeerTransportKind | null {
    return this.state.live.get(n)?.transport ?? null;
  }
  rttOf(n: string): number | null {
    return this.state.live.get(n)?.rttMs ?? null;
  }
  viaRelayOf(n: string): string | null {
    return viaRelayOfLive(this.state.live.get(n));
  }
  relayPresenceOf(n: string): string[] | undefined {
    return relayPresenceOfIndex(this.state.relayPresence, n);
  }
  linkDetailOf(nodeId: string): PeerLinkDetail {
    return peerLinkDetailFromState(
      this.state,
      nodeId,
      this.hubHostOf(),
      this.dcBreaker.snapshot(nodeId)
    );
  }
  onHubSwitched(): void {
    if (this.state.stopped) return;
    this.dcUpgrade.onHubSwitched();
  }
  forceDcProbe(nodeId: string): void {
    if (!isNodePaused(nodeId)) this.dialer.forceDcProbe(nodeId);
  }
  /** 对端最佳路径 RTT 记忆（含 TCP connect 样本）。 */
  get pathRttMemory() {
    return this.state.pathRtt;
  }
  rerollDc(nodeId: string): boolean {
    return this.reroll.forceReroll(nodeId);
  }

  async waitForTransport(
    nodeId: string,
    kind: PeerTransportKind,
    timeoutMs: number
  ): Promise<boolean> {
    return this.waiters.waitForTransport(nodeId, kind, timeoutMs);
  }

  sessionKeysOf(nodeId: string): { sendKey: Uint8Array; recvKey: Uint8Array } | null {
    const live = this.state.live.get(nodeId);
    if (!live?.sendKey || !live.recvKey) return null;
    return { sendKey: live.sendKey, recvKey: live.recvKey };
  }

  adoptLink(
    peerNodeId: string,
    session: LinkSession,
    transport: PeerTransportKind = 'ws-secure',
    initiatedBy?: string,
    remoteAddress?: string | null
  ): LinkSession | null {
    return this.registry.track(
      session,
      peerNodeId,
      transport,
      initiatedBy ?? peerNodeId,
      this.state.generation,
      false,
      remoteAddress ?? null
    );
  }

  receiveRtcSignal(fromNodeId: string, msg: RtcSignalMessage): void {
    receiveRtcSignal(this.ctlHost(), fromNodeId, msg);
  }
  protected maybeUpgrade(nodeId: string, opts: PeerUpgradeOpts): void {
    if (isNodePaused(nodeId) && !opts.peerInitiated && !opts.userPath) return;
    if (!this.routes.allowsUpgrade(nodeId, opts.peerInitiated === true)) return;
    if (!opts.peerInitiated) super.maybeUpgrade(nodeId, opts);
    else void this.dialer.dial(nodeId, { peerInitiated: true }).catch(() => undefined);
  }

  async getLink(nodeId: string, opts?: { purpose?: PeerLinkPurpose }): Promise<LinkSession> {
    return getPeerLink(
      {
        state: this.state,
        routes: this.routes,
        maybeUpgrade: (id, upgradeOpts) => this.maybeUpgrade(id, upgradeOpts),
        requireTrusted: (id) => this.requireTrusted(id),
        dialForeground: (id) => this.dialer.dial(id, { foreground: true }),
        awaitEstablishedOrDial: (id, pending) => this.waiters.awaitEstablishedOrDial(id, pending),
      },
      nodeId,
      opts
    );
  }

  onRevoked(nodeId: string): void {
    retirePeerDialState(peerDialRetireOf(this), nodeId, 'revoked');
  }

  notifyPeerEndpointsChanged(nodeId?: string): void {
    if (nodeId) {
      this.dialer.syncPeerEndpointSet(nodeId);
      this.maybeUpgrade(nodeId, { cooldown: true });
      return;
    }
    for (const id of this.state.live.keys()) {
      this.maybeUpgrade(id, { cooldown: true });
    }
  }

  async forceProbe(nodeId: string, endpoints?: string[]): Promise<LinkSession | null> {
    if (isNodePaused(nodeId)) return null;
    return this.dialer.forceProbe(nodeId, endpoints);
  }

  refreshAdvertisedStatus(): void {
    this.statusSync.refreshAdvertisedStatus();
  }

  notifyKeyLogHeadChanged(): void {
    this.statusSync.notifyKeyLogHeadChanged();
  }

  listReach(): Map<string, PeerReach> {
    return listPeerReach(this.state, (id) => this.onRevoked(id));
  }

  private isTrusted = (nodeId: string): boolean => isPeerTrusted(this.state, nodeId);

  private requireTrusted(nodeId: string): void {
    requirePeerAdmitted(this.state, nodeId, (id) => this.onRevoked(id));
  }
  private handlePeerCtl(live: LivePeer, bytes: Uint8Array): void {
    handlePeerCtl(this.ctlHost(), live, bytes);
  }
}
