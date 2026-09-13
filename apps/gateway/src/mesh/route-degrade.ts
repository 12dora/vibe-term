import type { LinkSession } from '@vibeterm/shared/link';
import {
  DEFAULT_MESH_ROUTE_MODE,
  type MeshPathKind,
  type MeshRouteMode,
  type MeshStreamClass,
} from '@vibeterm/shared/net';
import { encodeJsonBytes } from './ctl';
import { logLine } from './mesh-log';
import {
  PEER_PING_INTERVAL_MS,
  type PeerManagerState,
  measurePingRttMs,
  parseEchoedSentAt,
  readUplinkRtt,
} from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import { quiet } from './peer-ws-race';
import type { MeshRouteModeStore } from './route-mode-store';
import {
  ROUTE_DEGRADE_CONSECUTIVE,
  ROUTE_DEGRADE_MIN_SPAN_MS,
  ROUTE_PROMOTE_SAMPLES,
  decidePath,
  isDirectSlowVsRelay,
  isDirectTransport,
  nextPromoteBackoffMs,
  pathKindOf,
  readDirectMs,
  relayMsForPeer,
  shouldPromoteDirect,
} from './route-policy';
import type { PeerTransportKind } from './types';

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
    dcAttemptId?: string | null
  ) => LinkSession | null;
  finishRetire: (live: LivePeer, reason: string) => void;
  maybeUpgrade: (nodeId: string) => void;
};

type PeerRouteRecord = {
  consecutiveSlow: number;
  firstSlowAt: number | null;
  backoffUntil: number;
  backoffMs: number;
  degraded: boolean;
};

type DirectCandidate = {
  session: LinkSession;
  transport: 'dc' | 'ws-secure';
  initiatedBy: string;
  gen: number;
  remoteAddress: string | null;
  dcAttemptId: string | null;
  samples: number[];
  pingTimer: { clear: () => void } | null;
  pingSentAt: number | null;
};

function emptyRecord(): PeerRouteRecord {
  return {
    consecutiveSlow: 0,
    firstSlowAt: null,
    backoffUntil: 0,
    backoffMs: 0,
    degraded: false,
  };
}

function formatRouteSwitch(input: {
  peer: string;
  from: string;
  to: string;
  directMs: number | null;
  relayMs: number | null;
}): string {
  const direct = input.directMs == null ? '-' : String(Math.round(input.directMs));
  const relay = input.relayMs == null ? '-' : String(Math.round(input.relayMs));
  return `route_switch peer=${input.peer} from=${input.from} to=${input.to} direct_ms=${direct} relay_ms=${relay}`;
}

export class RouteDegradeCoordinator {
  private readonly ports: RouteDegradePorts;
  private readonly peers = new Map<string, PeerRouteRecord>();
  private readonly candidates = new Map<string, DirectCandidate>();
  private readonly inflight = new Map<string, Promise<LinkSession | null>>();
  private readonly measured = new WeakSet<LinkSession>();
  private unsub: (() => void) | null = null;
  private lastMode: MeshRouteMode;

  constructor(ports: RouteDegradePorts) {
    this.ports = ports;
    this.lastMode = ports.mode.get();
    this.unsub = ports.mode.subscribe((mode) => this.onModeChange(mode));
  }

  dispose(): void {
    this.unsub?.();
    this.unsub = null;
    for (const peerId of [...this.candidates.keys()]) this.dropCandidate(peerId, 'stopped');
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
    if (mode === 'direct') return true;
    if (this.candidates.has(peerId)) return false;
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
    return this.candidates.has(peerId);
  }

  interceptTrack(input: TrackInterceptInput): TrackIntercept {
    if (!isDirectTransport(input.transport)) return { action: 'continue' };
    if (this.measured.has(input.session)) return { action: 'continue' };
    if (!this.allowsInboundDirect()) return { action: 'reject', reason: 'route-relay' };
    if (this.mode() !== 'auto') return { action: 'continue' };
    const prev = input.prev;
    if (!prev || prev.transport !== 'relay') return { action: 'continue' };
    if (!this.peers.get(input.peerNodeId)?.degraded) return { action: 'continue' };
    this.holdCandidate(input);
    return { action: 'hold' };
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
    const candidate = this.candidates.get(peerId);
    if (!candidate) return;
    candidate.samples.push(Math.max(0, Math.round(sampleMs)));
    if (candidate.samples.length < ROUTE_PROMOTE_SAMPLES) return;
    this.settleCandidate(peerId, candidate);
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
      rec = emptyRecord();
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
    const session = await this.ports.openRelay(peerId);
    if (this.ports.state.stopped) {
      quiet(() => session.close('stopped'));
      return null;
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
    if (prev && this.ports.state.live.get(peerId)?.session !== prev.session) {
      this.ports.finishRetire(prev, 'retired');
    }
    this.armBackoff(peerId, true);
    logLine(
      '[mesh][peer]',
      formatRouteSwitch({
        peer: peerId,
        from,
        to: 'relay',
        directMs,
        relayMs: this.ports.state.live.get(peerId)?.rttMs ?? relayMs,
      })
    );
    return this.ports.state.live.get(peerId)?.session ?? session;
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
    this.peers.set(peerId, emptyRecord());
  }

  private holdCandidate(input: TrackInterceptInput): void {
    if (!isDirectTransport(input.transport)) return;
    this.dropCandidate(input.peerNodeId, 'replaced-candidate');
    const candidate: DirectCandidate = {
      session: input.session,
      transport: input.transport,
      initiatedBy: input.initiatedBy,
      gen: input.gen,
      remoteAddress: input.remoteAddress,
      dcAttemptId: input.dcAttemptId,
      samples: [],
      pingTimer: null,
      pingSentAt: null,
    };
    this.candidates.set(input.peerNodeId, candidate);
    this.bindCandidatePing(input.peerNodeId, candidate);
  }

  private bindCandidatePing(peerId: string, candidate: DirectCandidate): void {
    const session = candidate.session;
    quiet(() => {
      session.onStream((stream) => {
        if (this.candidates.get(peerId) !== candidate) return;
        quiet(() => stream.reset('pending-measure'));
      });
    });
    session.ctl.onMessage((bytes) => {
      if (this.candidates.get(peerId) !== candidate) return;
      const msg = parseOpenPayload(bytes);
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') {
        const sentAt = parseEchoedSentAt(msg.sentAt);
        quiet(() =>
          session.ctl.send(encodeJsonBytes(sentAt == null ? { t: 'pong' } : { t: 'pong', sentAt }))
        );
        return;
      }
      if (msg.t !== 'pong') return;
      const sample = measurePingRttMs(
        performance.now(),
        parseEchoedSentAt(msg.sentAt),
        candidate.pingSentAt
      );
      candidate.pingSentAt = null;
      if (sample == null) return;
      this.noteCandidateSample(peerId, sample);
    });
    const sendPing = () => {
      if (this.candidates.get(peerId) !== candidate) return;
      candidate.pingSentAt = performance.now();
      quiet(() => session.ctl.send(encodeJsonBytes({ t: 'ping', sentAt: candidate.pingSentAt })));
    };
    sendPing();
    candidate.pingTimer = this.ports.state.scheduler.interval(sendPing, PEER_PING_INTERVAL_MS);
    void session.closed.then(() => {
      if (this.candidates.get(peerId) === candidate) this.candidates.delete(peerId);
    });
  }

  private settleCandidate(peerId: string, candidate: DirectCandidate): void {
    const live = this.ports.state.live.get(peerId);
    const relayMs = this.relayMsOf(peerId, live);
    const directMs = Math.max(...candidate.samples);
    const accept =
      relayMs != null && candidate.samples.every((ms) => shouldPromoteDirect(ms, relayMs));
    this.candidates.delete(peerId);
    candidate.pingTimer?.clear();
    if (!accept) {
      quiet(() => candidate.session.close('route-measure-reject'));
      this.armBackoff(peerId, true);
      return;
    }
    this.measured.add(candidate.session);
    const prev = live;
    const kept = this.ports.forceInstall(
      candidate.session,
      peerId,
      candidate.transport,
      candidate.initiatedBy,
      candidate.gen,
      candidate.remoteAddress,
      candidate.dcAttemptId
    );
    if (!kept) {
      quiet(() => candidate.session.close('route-measure-reject'));
      this.armBackoff(peerId, true);
      return;
    }
    if (prev && prev.session !== kept) this.ports.finishRetire(prev, 'retired');
    this.resetPeer(peerId);
    logLine(
      '[mesh][peer]',
      formatRouteSwitch({
        peer: peerId,
        from: prev?.transport ?? 'relay',
        to: candidate.transport,
        directMs,
        relayMs,
      })
    );
  }

  private dropCandidate(peerId: string, reason: string): void {
    const candidate = this.candidates.get(peerId);
    if (!candidate) return;
    this.candidates.delete(peerId);
    candidate.pingTimer?.clear();
    quiet(() => candidate.session.close(reason));
  }

  private onModeChange(mode: MeshRouteMode): void {
    const prev = this.lastMode;
    this.lastMode = mode;
    if (mode === prev) return;
    for (const peerId of [...this.candidates.keys()]) {
      if (mode === 'direct') this.promoteCandidateNow(peerId);
      else this.dropCandidate(peerId, 'route-mode');
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

  private promoteCandidateNow(peerId: string): void {
    const candidate = this.candidates.get(peerId);
    if (!candidate) return;
    this.candidates.delete(peerId);
    candidate.pingTimer?.clear();
    this.measured.add(candidate.session);
    const prev = this.ports.state.live.get(peerId);
    const kept = this.ports.forceInstall(
      candidate.session,
      peerId,
      candidate.transport,
      candidate.initiatedBy,
      candidate.gen,
      candidate.remoteAddress,
      candidate.dcAttemptId
    );
    if (!kept) quiet(() => candidate.session.close('route-mode'));
    else if (prev && prev.session !== kept) this.ports.finishRetire(prev, 'retired');
  }
}
