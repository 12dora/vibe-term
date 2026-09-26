import type { LinkSession } from '@vibeterm/shared/link';
import {
  DEFAULT_MESH_ROUTE_MODE,
  type MeshPathKind,
  type MeshRouteMode,
  type MeshStreamClass,
} from '@vibeterm/shared/net';
import { logLine } from './mesh-log';
import { type PeerManagerState, readUplinkRtt } from './peer-manager-state';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import {
  armPendingMeasureWatch,
  attachRemoteHold,
  borrowRelayForRemoteHold,
  detachRemoteHold,
  remoteDirectBlocked,
  resolveRefusedUserLink,
} from './pending-measure-hold';
import { CandidateHold, type CandidateOffer } from './route-degrade-hold';
import { type PeerRouteRecord, emptyRouteRecord, formatRouteSwitch } from './route-degrade-record';
import type { MeshRouteModeStore } from './route-mode-store';
import {
  ROUTE_DEGRADE_CONSECUTIVE,
  ROUTE_DEGRADE_MIN_SPAN_MS,
  decidePath,
  isDirectSlowVsRelay,
  isDirectTransport,
  nextPromoteBackoffMs,
  pathKindOf,
  readDirectMs,
  relayMsForPeer,
} from './route-policy';
import type { PeerTransportKind } from './types';

export type { CandidateOffer };

export type RouteModeHolder = Pick<MeshRouteModeStore, 'get' | 'subscribe'>;

export function defaultRouteModeHolder(): RouteModeHolder {
  return {
    get: () => DEFAULT_MESH_ROUTE_MODE,
    subscribe: () => () => {},
  };
}

export type TrackInterceptInput = {
  session: LinkSession;
  peerNodeId: string;
  transport: PeerTransportKind;
  initiatedBy: string;
  gen: number;
  remoteAddress: string | null;
  dcAttemptId: string | null;
  rtcEpoch?: number;
  quiesceCapable?: boolean;
  prev: LivePeer | undefined;
};

export type TrackIntercept =
  | { action: 'continue' }
  | { action: 'reject'; reason: string }
  | { action: 'hold' };

export type RouteDegradePorts = {
  state: PeerManagerState;
  mode: RouteModeHolder;
  openRelay: (nodeId: string) => Promise<LinkSession>;
  forceInstall: (
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress?: string | null,
    dcAttemptId?: string | null,
    rtcEpoch?: number
  ) => LinkSession | null;
  finishRetire: (live: LivePeer, reason: string) => void;
  maybeUpgrade: (nodeId: string) => void;
  openUntrackedRelay?: (nodeId: string) => Promise<LinkSession>;
  parkSide?: (peerId: string, session: LinkSession) => void;
};

export class RouteDegradeCoordinator {
  private readonly ports: RouteDegradePorts;
  private readonly peers = new Map<string, PeerRouteRecord>();
  private readonly inflight = new Map<string, Promise<LinkSession | null>>();
  private readonly hold: CandidateHold;
  private unsub: (() => void) | null = null;
  private lastMode: MeshRouteMode;

  constructor(ports: RouteDegradePorts) {
    this.ports = ports;
    this.lastMode = ports.mode.get();
    this.hold = new CandidateHold({
      now: () => this.now(),
      selfId: () => this.ports.state.identity.nodeId,
      mode: () => this.mode(),
      isDegraded: (peerId) => this.isDegraded(peerId),
      allowsInboundDirect: () => this.allowsInboundDirect(),
      scheduler: ports.state.scheduler,
      live: (peerId) => this.ports.state.live.get(peerId),
      relayMs: (peerId, live) => this.relayMsOf(peerId, live),
      recordOf: (peerId) => this.recordOf(peerId),
      resetPeer: (peerId) => this.resetPeer(peerId),
      armDegradedBackoff: (peerId) => this.armBackoff(peerId, true),
      watchMeasure: (session, peerId) => armPendingMeasureWatch(this, session, peerId),
      forceInstall: (...args) => this.ports.forceInstall(...args),
      finishRetire: (live, reason) => this.ports.finishRetire(live, reason),
    });
    this.unsub = ports.mode.subscribe((mode) => this.onModeChange(mode));
    attachRemoteHold(this);
  }

  dispose(): void {
    detachRemoteHold(this);
    this.unsub?.();
    this.unsub = null;
    this.hold.dispose();
    this.peers.clear();
    this.inflight.clear();
  }

  mode(): MeshRouteMode {
    return this.ports.mode.get();
  }

  allowsInboundDirect(): boolean {
    return this.mode() !== 'relay';
  }

  allowsOutboundDirect(peerId: string): boolean {
    const mode = this.mode();
    if (mode === 'relay') return false;
    if (remoteDirectBlocked(this, peerId, Date.now())) return false;
    if (mode === 'direct') return true;
    if (this.hold.has(peerId)) return false;
    const rec = this.peers.get(peerId);
    return !rec || this.now() >= rec.backoffUntil;
  }

  allowsUpgrade(peerId: string, peerInitiated: boolean): boolean {
    return peerInitiated ? this.allowsInboundDirect() : this.allowsOutboundDirect(peerId);
  }

  decidePath(peerId: string, streamClass: MeshStreamClass): MeshPathKind {
    return decidePath(peerId, streamClass, this.snapshot(peerId, streamClass));
  }

  isDegraded(peerId: string): boolean {
    return this.peers.get(peerId)?.degraded === true;
  }

  hasCandidate(peerId: string): boolean {
    return this.hold.has(peerId);
  }

  /** 直连候选测量。已完成的 DC 重掷也走这里：有 RTT 时先测量再换，没有 RTT 时直接装上。 */
  offerCandidate(input: CandidateOffer): 'held' | 'installed' | 'rejected' {
    return this.hold.offer(input);
  }

  /** WP-B pause/revoke 调用：丢掉该对端还在测量的直连候选。 */
  dropCandidates(peerId: string, reason = 'paused'): void {
    this.hold.drop(peerId, reason);
  }

  promoteHeldCandidate(peerId: string): void {
    this.hold.promoteNow(peerId);
  }

  interceptTrack(input: TrackInterceptInput): TrackIntercept {
    return this.hold.intercept(input);
  }

  onRttSample(live: LivePeer, _sampleMs: number): void {
    if (this.ports.state.live.get(live.peerNodeId) !== live) return;
    if (this.mode() !== 'auto') return;
    if (!isDirectTransport(live.transport)) return;
    const rec = this.recordOf(live.peerNodeId);
    const directMs = live.rttMs;
    const relayMs = this.relayMsOf(live.peerNodeId, live);
    if (directMs == null || relayMs == null || !isDirectSlowVsRelay(directMs, relayMs)) {
      rec.consecutiveSlow = 0;
      rec.firstSlowAt = null;
      return;
    }
    const now = this.now();
    rec.consecutiveSlow += 1;
    rec.firstSlowAt ??= now;
    if (
      rec.consecutiveSlow >= ROUTE_DEGRADE_CONSECUTIVE &&
      now - rec.firstSlowAt >= ROUTE_DEGRADE_MIN_SPAN_MS
    ) {
      rec.consecutiveSlow = 0;
      rec.firstSlowAt = null;
      void this.degradeToRelay(live.peerNodeId).catch(() => undefined);
    }
  }

  async ensureLiveForMode(live: LivePeer): Promise<LinkSession | null> {
    if (this.mode() !== 'relay') return null;
    if (!isDirectTransport(live.transport)) return null;
    return this.degradeToRelay(live.peerNodeId);
  }

  /** 对端测量期间走 retiring 非 DC；只有 auto 才旁路拨中继，不降级也不拆 DC。 */
  async userLinkWhileRemoteHold(live: LivePeer): Promise<LinkSession | null> {
    return resolveRefusedUserLink(this, live, {
      now: Date.now(),
      mode: this.mode(),
      retiring: this.ports.state.retiring.get(live.peerNodeId),
      dialRelay: () => borrowRelayForRemoteHold(this, live.peerNodeId),
    });
  }

  async degradeToRelay(peerId: string): Promise<LinkSession | null> {
    const existing = this.inflight.get(peerId);
    if (existing) return existing;
    const pending = this.runDegrade(peerId);
    this.inflight.set(peerId, pending);
    try {
      return await pending;
    } finally {
      if (this.inflight.get(peerId) === pending) this.inflight.delete(peerId);
    }
  }

  noteCandidateSample(peerId: string, sampleMs: number): void {
    this.hold.noteSample(peerId, sampleMs);
  }

  private snapshot(peerId: string, streamClass: MeshStreamClass) {
    const live = this.ports.state.live.get(peerId);
    const rec = this.peers.get(peerId);
    return {
      mode: this.mode(),
      streamClass,
      liveKind: live ? pathKindOf(live.transport) : null,
      directMs: this.directMsOf(peerId, live),
      relayMs: this.relayMsOf(peerId, live),
      degraded: rec?.degraded === true,
      backoffActive: rec != null && this.now() < rec.backoffUntil,
    };
  }

  private now(): number {
    return this.ports.state.scheduler.now();
  }

  private recordOf(peerId: string): PeerRouteRecord {
    let rec = this.peers.get(peerId);
    if (!rec) {
      rec = emptyRouteRecord();
      this.peers.set(peerId, rec);
    }
    return rec;
  }

  private directMsOf(peerId: string, live: LivePeer | undefined): number | null {
    return readDirectMs({
      liveTransport: live?.transport,
      liveRttMs: live?.rttMs,
      peerId,
      pathRtt: this.ports.state.pathRtt,
    });
  }

  private relayMsOf(peerId: string, live: LivePeer | undefined): number | null {
    return relayMsForPeer({
      liveTransport: live?.transport,
      liveRttMs: live?.rttMs,
      peerId,
      selfUplinkMs: readUplinkRtt(this.ports.state.uplink),
      presence: this.ports.state.relayPresence,
    });
  }

  private async runDegrade(peerId: string): Promise<LinkSession | null> {
    const live = this.ports.state.live.get(peerId);
    if (live?.transport === 'relay') return live.session;
    const from = live?.transport ?? 'dc';
    const directMs = live?.rttMs ?? this.directMsOf(peerId, live);
    const relayMs = this.relayMsOf(peerId, live);
    const prev = live;
    const sourceLive = live;
    const sourceGen = this.ports.state.generation;
    const session = await this.ports.openRelay(peerId);
    if (this.ports.state.stopped) {
      quiet(() => session.close('stopped'));
      return null;
    }
    if (!this.degradeStillCurrent(peerId, sourceLive, sourceGen, session)) {
      return this.abandonLateRelay(peerId, session);
    }
    const nowLive = this.ports.state.live.get(peerId);
    if (nowLive?.transport !== 'relay') {
      const kept = this.ports.forceInstall(
        session,
        peerId,
        'relay',
        this.ports.state.identity.nodeId,
        this.ports.state.generation
      );
      if (!kept) return null;
    }
    return this.commitRelay({ peerId, session, prev, from, directMs, relayMs });
  }

  private commitRelay(input: {
    peerId: string;
    session: LinkSession;
    prev: LivePeer | undefined;
    from: string;
    directMs: number | null;
    relayMs: number | null;
  }): LinkSession | null {
    const installed = this.ports.state.live.get(input.peerId);
    if (installed?.session !== input.session || installed.transport !== 'relay') {
      logLine('[mesh][peer]', `route_switch_abandoned peer=${input.peerId}`);
      return installed?.session ?? null;
    }
    if (input.prev && input.prev.session !== installed.session) {
      this.ports.finishRetire(input.prev, 'retired');
    }
    this.armBackoff(input.peerId, true);
    logLine(
      '[mesh][peer]',
      formatRouteSwitch({
        peer: input.peerId,
        from: input.from,
        to: 'relay',
        directMs: input.directMs,
        relayMs: installed.rttMs ?? input.relayMs,
      })
    );
    return installed.session;
  }

  private degradeStillCurrent(
    peerId: string,
    sourceLive: LivePeer | undefined,
    sourceGen: number,
    session: LinkSession
  ): boolean {
    const mode = this.mode();
    if (mode !== 'auto' && mode !== 'relay') return false;
    if (this.ports.state.generation !== sourceGen) return false;
    const nowLive = this.ports.state.live.get(peerId);
    return nowLive === sourceLive || nowLive?.session === session;
  }

  private abandonLateRelay(peerId: string, session: LinkSession): LinkSession | null {
    quiet(() => session.close('route_switch_abandoned'));
    logLine('[mesh][peer]', `route_switch_abandoned peer=${peerId}`);
    const kept = this.ports.state.live.get(peerId);
    if (kept?.session === session) return null;
    return kept?.session ?? null;
  }

  private armBackoff(peerId: string, degraded: boolean): void {
    const rec = this.recordOf(peerId);
    rec.degraded = rec.degraded || degraded;
    rec.consecutiveSlow = 0;
    rec.firstSlowAt = null;
    rec.backoffMs = nextPromoteBackoffMs(rec.backoffMs);
    rec.backoffUntil = this.now() + rec.backoffMs;
  }

  private resetPeer(peerId: string): void {
    this.peers.set(peerId, emptyRouteRecord());
  }

  private onModeChange(mode: MeshRouteMode): void {
    const prev = this.lastMode;
    this.lastMode = mode;
    if (mode === prev) return;
    for (const peerId of this.hold.ids()) {
      if (mode === 'direct') this.hold.promoteNow(peerId);
      else this.hold.drop(peerId, 'route-mode');
    }
    for (const peerId of [...this.peers.keys()]) this.resetPeer(peerId);
    if (mode === 'relay') {
      for (const live of this.ports.state.live.values()) {
        if (isDirectTransport(live.transport)) {
          void this.degradeToRelay(live.peerNodeId).catch(() => undefined);
        }
      }
      return;
    }
    if (mode === 'direct' || mode === 'auto') {
      for (const live of this.ports.state.live.values()) {
        if (live.transport === 'relay') this.ports.maybeUpgrade(live.peerNodeId);
      }
    }
  }
}
