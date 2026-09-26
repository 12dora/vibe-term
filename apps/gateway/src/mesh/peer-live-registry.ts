import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { classifyPeerReach } from './address-class';
import {
  UnstableDcBackoff,
  applyRouteCloseCooldown,
  armUnstableHealthyTimer,
  bindLiveDcProof,
  clearUnstableHealthyTimer,
  logDcDrop,
  noteLiveDcProof,
  settleEstablishedDcDrop,
  unbindLiveDcProof,
} from './peer-dc-proof';
import { attachLiveBinding, buildInstalledPeer } from './peer-live-bind';
import type { PeerInboundStreamHost } from './peer-live-inbound';
import { armPeerPing, clearOutstandingPing, shouldEmitPeerRtt } from './peer-live-ping';
import {
  applyExistingLive,
  bestRetiringPeer,
  consumeForcedSession,
  earlyTrackResult,
  existingLiveDecision,
  preparePromotedPeer,
} from './peer-live-rank';
import type { PeerLiveRegistryDeps, PeerLiveRegistryOptions } from './peer-live-types';
export type { PeerLiveRegistryDeps, PeerLiveRegistryOptions } from './peer-live-types';
import {
  PEER_DC_IDLE_MS,
  PEER_PING_INTERVAL_MS,
  type PeerManagerState,
  applyPeerRttSample,
  isPeerTrusted,
  lookupPeerRttMsForLink,
  measurePingRttMs,
  peerStale,
} from './peer-manager-state';
import { type LivePeer, peerDropPlan } from './peer-reconnect-wake';
import { PEER_RTC_WAKE_COOLDOWN_MS } from './peer-rtc-wake';
import * as sideRelay from './peer-side-relay';
import { quiet } from './peer-ws-race';
import { rememberLinkTransport } from './pending-measure-hold';
import { getRelayDialBreaker } from './relay-dial-breaker';
import { closeRouteSession } from './route-decline';
import type { CandidateOffer } from './route-degrade-hold';
import { flushDialFailed } from './rtc/rtc-log';
import { setSessionRole, stampInstallMeta } from './session-binding';
import type { PeerTransportKind } from './types';
import { noteLiveRelayStream } from './uplink-relay-drain';
type TrackOpenInput = {
  session: LinkSession;
  peerNodeId: string;
  transport: PeerTransportKind;
  initiatedBy: string;
  gen: number;
  quiesceCapable: boolean;
  resolvedAddress: string | null;
  dcAttemptId: string | null;
  rtcEpoch?: number;
  prev: LivePeer | undefined;
  reject: (reason: string, keep?: LinkSession | null) => LinkSession | null;
};

export class PeerLiveRegistry {
  private readonly state: PeerManagerState;
  private readonly deps: PeerLiveRegistryDeps;
  private readonly idleMs: number;
  private readonly maxConcurrentStreams: number;
  private readonly sessionStore?: PeerLiveRegistryOptions['sessionStore'];
  private readonly dispatchHttp: PeerLiveRegistryOptions['dispatchHttp'];
  private readonly wsServer?: PeerLiveRegistryOptions['wsServer'];
  private readonly onGatewaySession: PeerLiveRegistryOptions['onGatewaySession'];
  private readonly onGatewaySessionClose: PeerLiveRegistryOptions['onGatewaySessionClose'];
  private readonly onLinkInfo: PeerLiveRegistryOptions['onLinkInfo'];
  private readonly inboundHost: PeerInboundStreamHost;
  private linkInfoHold = 0;
  private readonly bypassRank = new WeakSet<LinkSession>();
  private readonly unstableDc = new UnstableDcBackoff();
  private readonly unstableClear = new Map<string, { clear(): void }>();

  constructor(state: PeerManagerState, opts: PeerLiveRegistryOptions) {
    this.state = state;
    this.deps = opts.deps;
    this.idleMs = opts.idleMs;
    this.maxConcurrentStreams = opts.maxConcurrentStreams;
    this.sessionStore = opts.sessionStore;
    this.dispatchHttp = opts.dispatchHttp;
    this.wsServer = opts.wsServer;
    this.onGatewaySession = opts.onGatewaySession;
    this.onGatewaySessionClose = opts.onGatewaySessionClose;
    this.onLinkInfo = opts.onLinkInfo;
    this.inboundHost = {
      selfNodeId: state.identity.nodeId,
      dispatchHttp: this.dispatchHttp,
      sessionStore: this.sessionStore,
      wsServer: this.wsServer,
      now: () => this.state.scheduler.now(),
      onGatewaySession: this.onGatewaySession,
      onGatewaySessionClose: this.onGatewaySessionClose,
    };
  }

  track(
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable = false,
    remoteAddress: string | null = null,
    dcAttemptId: string | null = null,
    rtcEpoch?: number
  ): LinkSession | null {
    const reject = (reason: string, keep: LinkSession | null = null) => {
      quiet(() => session.close(reason));
      return keep;
    };
    if (peerStale(this.state, gen)) return reject('stale');
    if (!isPeerTrusted(this.state, peerNodeId)) return reject('not-trusted');
    const prev = this.state.live.get(peerNodeId);
    const resolvedAddress =
      remoteAddress ?? (transport === 'dc' ? (prev?.remoteAddress ?? null) : null);
    stampInstallMeta(session, {
      remoteAddress: resolvedAddress,
      dcAttemptId,
      quiesceCapable,
      rtcEpoch,
    });
    return this.trackOpen({
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      quiesceCapable,
      resolvedAddress,
      dcAttemptId,
      rtcEpoch,
      prev,
      reject,
    });
  }

  private trackOpen(input: TrackOpenInput): LinkSession | null {
    const {
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      quiesceCapable,
      resolvedAddress,
      dcAttemptId,
      rtcEpoch,
      prev,
      reject,
    } = input;
    if (consumeForcedSession(this.bypassRank, session)) {
      return this.installForced({
        session,
        peerNodeId,
        transport,
        initiatedBy,
        gen,
        quiesceCapable,
        remoteAddress: resolvedAddress,
        dcAttemptId,
        rtcEpoch,
        prev,
      });
    }
    const early = earlyTrackResult(
      this.deps.interceptTrack?.({
        session,
        peerNodeId,
        transport,
        initiatedBy,
        gen,
        rtcEpoch,
        prev,
        remoteAddress: resolvedAddress,
        dcAttemptId,
        quiesceCapable,
      }),
      prev,
      (reason) =>
        closeRouteSession({
          selfId: this.state.identity.nodeId,
          peerId: peerNodeId,
          session,
          also: prev?.session,
          reason,
          epoch: rtcEpoch,
        })
    );
    if (early) return early.result;
    const applied = applyExistingLive(
      existingLiveDecision(prev, session, transport, initiatedBy, this.state.identity.nodeId),
      prev,
      () => {
        if (!prev) return;
        this.deps.parkInbound(peerNodeId, session, transport, initiatedBy, gen, resolvedAddress);
        this.deps.probeQuiesce(prev);
      },
      () => {
        if (prev) this.deps.retirePeer(prev, 'replaced');
      }
    );
    if ('reject' in applied) return reject(applied.reject, prev?.session ?? null);
    if ('parked' in applied) return applied.parked;
    return this.installLive(
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      quiesceCapable,
      resolvedAddress,
      dcAttemptId,
      rtcEpoch
    );
  }
  forceInstall(
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress: string | null = null,
    dcAttemptId: string | null = null
  ): LinkSession | null {
    this.bypassRank.add(session);
    return this.track(
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      false,
      remoteAddress,
      dcAttemptId
    );
  }
  private installForced(input: {
    session: LinkSession;
    peerNodeId: string;
    transport: PeerTransportKind;
    initiatedBy: string;
    gen: number;
    quiesceCapable: boolean;
    remoteAddress: string | null;
    dcAttemptId: string | null;
    rtcEpoch?: number;
    prev: LivePeer | undefined;
  }): LinkSession {
    const { session, prev } = input;
    if (prev?.session === session || this.state.live.get(input.peerNodeId)?.session === session) {
      return session;
    }
    if (prev) this.deps.retirePeer(prev, 'replaced');
    return this.installLive(
      session,
      input.peerNodeId,
      input.transport,
      input.initiatedBy,
      input.gen,
      input.quiesceCapable,
      input.remoteAddress,
      input.dcAttemptId,
      input.rtcEpoch
    );
  }

  private installLive(
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable: boolean,
    remoteAddress: string | null,
    dcAttemptId: string | null = null,
    rtcEpoch?: number
  ): LinkSession {
    if (this.state.live.get(peerNodeId)?.session === session) return session;
    const keys = this.state.sessionKeys.get(session);
    const live = buildInstalledPeer({
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      quiesceCapable,
      remoteAddress,
      dcAttemptId,
      rtcEpoch,
      now: this.state.scheduler.now(),
      sendKey: keys?.sendKey,
      recvKey: keys?.recvKey,
      nextDcAttemptId: () => this.deps.nextDcAttemptId(),
    });
    rememberLinkTransport(session, transport);
    this.state.live.set(peerNodeId, live);
    if (transport === 'dc') {
      this.armDcProof(live);
      this.deps.dcBreaker.noteChannelEstablished(peerNodeId, live.dcAttemptId ?? undefined);
      flushDialFailed(peerNodeId, { cause: 'established' });
      this.armDcHealth(live, peerNodeId);
    }
    if (transport === 'dc' || transport === 'ws-secure') {
      this.deps.clearDirectFailure(peerNodeId);
    }
    attachLiveBinding(
      {
        state: this.state,
        maxConcurrentStreams: this.maxConcurrentStreams,
        inbound: this.inboundHost,
        handlePeerCtl: (row, bytes) => this.deps.handlePeerCtl(row, bytes),
        onStreamOpened: (row, stream) => this.onLocalStream(row, stream),
        onPong: (row, echoed) => this.onPeerPong(row, echoed),
        onClosed: (row, reason) => this.onLiveClosed(row, reason),
      },
      live
    );
    if (!live.quiesceCapable) this.deps.sendLinkHello(live);
    this.armIdle(live);
    this.startPing(live);
    this.deps.sendPeerStatus(live);
    this.deps.notifyTransport(peerNodeId);
    this.deps.notifyLive(peerNodeId, session);
    this.emitLinkInfo(live);
    if (transport === 'dc') {
      this.state.lostDirect.delete(peerNodeId);
      this.deps.cancelDcUpgradeRetry(peerNodeId);
    } else if (this.state.lostDirect.has(peerNodeId) && live.quiesceCapable) {
      this.deps.armDcUpgradeRetry(peerNodeId);
    }
    return session;
  }

  private onLiveClosed(live: LivePeer, reason: string): void {
    if (this.state.live.get(live.peerNodeId)?.session === live.session) {
      this.dropPeer(live.peerNodeId, reason);
    }
    const set = this.state.retiring.get(live.peerNodeId);
    if (!set) return;
    for (const row of [...set]) {
      if (row.session === live.session) this.deps.finishRetire(row, reason);
    }
  }

  private onLocalStream(live: LivePeer, stream: LinkStream): void {
    noteLiveRelayStream(live, stream);
    live.streams += 1;
    live.lastStreamAt = this.state.scheduler.now();
    live.zeroStreamsSince = 0;
    this.clearIdle(live);
    if (live.retiring) {
      live.gotQuiesceAck = false;
      live.gotPeerQuiesce = false;
      this.deps.armRetireTimer(live);
    }
    void stream.closed.then(() => {
      live.streams = Math.max(0, live.streams - 1);
      live.lastStreamAt = this.state.scheduler.now();
      if (live.streams === 0) live.zeroStreamsSince = this.state.scheduler.now();
      if (live.streams > 0) return;
      if (live.retiring) {
        this.deps.restartQuiesce(live);
        this.deps.maybeFinishRetire(live);
        if (live.retiring && !live.finishRetired) this.deps.armRetireTimer(live);
        return;
      }
      if (this.state.live.get(live.peerNodeId) === live) this.armIdle(live);
    });
  }
  startPing(live: LivePeer): void {
    armPeerPing({
      live,
      intervalMs: PEER_PING_INTERVAL_MS,
      schedule: (fn, ms) => this.state.scheduler.interval(fn, ms),
      current: () => this.state.live.get(live.peerNodeId),
      retiring: () => this.state.retiring.get(live.peerNodeId),
      rttMs: () => lookupPeerRttMsForLink(live.session, this.state.scheduler),
      sendCtl: (msg) => this.deps.sendPeerCtl(live, msg),
      onDropLive: () => this.dropPeer(live.peerNodeId, 'missed-pong'),
      onDropRetire: () => this.deps.finishRetire(live, 'missed-pong'),
    });
  }
  onPeerPong(live: LivePeer, echoedSentAt?: number): void {
    live.missedPongs = 0;
    if (this.state.live.get(live.peerNodeId) !== live) clearOutstandingPing(live);
    if (this.state.live.get(live.peerNodeId) !== live) return;
    const answered = live.pingSentAt != null;
    const sample = measurePingRttMs(performance.now(), echoedSentAt, live.pingSentAt);
    live.pingSentAt = null;
    if (sample == null) return;
    if (answered) this.noteMuxProof(live);
    applyPeerRttSample(live, sample);
    this.deps.onRttSample(live, sample);
    this.maybeEmitRtt(live);
  }

  emitLinkInfo(live: LivePeer): void {
    this.emitInfo(live.peerNodeId, live);
  }
  emitOfflineLinkInfo(nodeId: string): void {
    this.emitInfo(nodeId, null);
  }
  private emitInfo(nodeId: string, live: LivePeer | null): void {
    if (this.linkInfoHold > 0) return;
    const breaker = this.deps.relayBreaker ?? getRelayDialBreaker();
    this.onLinkInfo?.({
      nodeId,
      reach: live ? classifyPeerReach(live.transport, live.remoteAddress) : null,
      transport: live?.transport ?? null,
      rttMs: live?.rttMs ?? null,
      dcBreaker: this.deps.dcBreaker.snapshot(nodeId),
      relayBreaker: breaker.snapshot(nodeId),
    });
  }
  private maybeEmitRtt(live: LivePeer): void {
    const now = this.state.scheduler.now();
    if (!shouldEmitPeerRtt(live, now)) return;
    live.lastRttEmitAt = now;
    live.lastEmittedRttMs = live.rttMs;
    this.emitLinkInfo(live);
  }
  armIdle(live: LivePeer): void {
    this.clearIdle(live);
    if (this.state.live.get(live.peerNodeId) !== live) return;
    if (live.streams > 0) return;
    const idleMs = live.transport === 'dc' ? PEER_DC_IDLE_MS : this.idleMs;
    const startedAt = this.state.scheduler.now();
    live.idleTimer = this.state.scheduler.interval(
      () => {
        if (this.state.live.get(live.peerNodeId) !== live) return;
        if (live.streams > 0) return;
        if (
          this.state.scheduler.now() - live.lastStreamAt >= idleMs &&
          this.state.scheduler.now() - startedAt >= idleMs
        ) {
          this.dropPeer(live.peerNodeId, 'idle');
        }
      },
      Math.max(1, idleMs)
    );
  }
  clearIdle(live: LivePeer): void {
    live.idleTimer?.clear();
    live.idleTimer = null;
  }
  dropPeer(nodeId: string, reason: string): void {
    this.clearUnstableTimer(nodeId);
    const live = this.state.live.get(nodeId);
    logDcDrop(live, reason, this.state.scheduler.now());
    unbindLiveDcProof(live);
    const intentional = applyRouteCloseCooldown(this.deps.dcBreaker, live, nodeId, reason);
    const plan = peerDropPlan(live, reason, this.state.stopped, intentional);
    const drainLive = plan.drain ? live : null;
    const dcAttemptId = live?.dcAttemptId ?? null;
    if (plan.wasDc) this.deps.cancelDcHealthTimer(nodeId);
    if (live) {
      if (drainLive) this.deps.retirePeer(live, reason);
      else {
        this.state.live.delete(nodeId);
        this.deps.finishRetire(live, reason);
      }
    }
    sideRelay.releaseSideRelay(this.state, nodeId, plan, reason, (session) =>
      this.adoptSideRelay(nodeId, session)
    );
    const incoming = this.deps.ensureIncomingWakeGate(nodeId);
    incoming.nextEligibleAt = Math.max(
      incoming.nextEligibleAt,
      this.state.scheduler.now() + PEER_RTC_WAKE_COOLDOWN_MS
    );
    this.deps.notifyTransport(nodeId);
    if (plan.terminal) {
      this.deps.cancelDcUpgradeRetry(nodeId);
      this.state.lostDirect.delete(nodeId);
      if (plan.revoked) this.deps.dcBreaker.reset(nodeId);
      this.deps.dropParked(nodeId, reason);
      this.dropCandidates(nodeId, reason);
      this.emitOfflineLinkInfo(nodeId);
      return;
    }
    if (plan.countDcFailure) {
      settleEstablishedDcDrop({
        breaker: this.deps.dcBreaker,
        unstable: this.unstableDc,
        peer: nodeId,
        reason,
        attemptId: dcAttemptId,
        live,
        now: this.state.scheduler.now(),
      });
    }
    if (plan.wasDc) {
      this.deps.dcBreaker.noteChannelLost?.(nodeId, dcAttemptId ?? undefined);
      this.state.lostDirect.add(nodeId);
      const gate = this.deps.ensureGate(nodeId);
      gate.failures = 0;
      gate.nextEligibleAt = 0;
      gate.coalesced = false;
    }
    this.linkInfoHold += 1;
    try {
      this.promoteRetiring(nodeId, drainLive);
      this.deps.activateParked(nodeId);
      if (!this.state.live.get(nodeId)) this.deps.promoteHeldCandidate?.(nodeId);
    } finally {
      this.linkInfoHold -= 1;
    }
    if (plan.wasDc) this.deps.armDcUpgradeRetry(nodeId);
    const next = this.state.live.get(nodeId);
    if (next) this.emitLinkInfo(next);
    else this.emitOfflineLinkInfo(nodeId);
  }
  private adoptSideRelay(nodeId: string, session: LinkSession): void {
    this.state.sideRelays.delete(nodeId);
    const id = this.state.identity.nodeId;
    this.installLive(session, nodeId, 'relay', id, this.state.generation, false, null);
  }

  parkSide(peerId: string, session: LinkSession): void {
    sideRelay.parkSideRelay(
      this.state,
      peerId,
      session,
      this.inboundHost,
      this.maxConcurrentStreams
    );
  }

  offerCandidate(offer: CandidateOffer): 'held' | 'installed' | 'rejected' {
    return this.deps.offerCandidate?.(offer) ?? 'rejected';
  }

  dropCandidates(peerId: string, reason = 'paused'): void {
    this.deps.dropCandidates?.(peerId, reason);
  }

  private promoteRetiring(nodeId: string, excluded?: LivePeer | null): boolean {
    if (this.state.live.get(nodeId)) return false;
    const set = this.state.retiring.get(nodeId);
    if (!set || set.size === 0) return false;
    const best = bestRetiringPeer(set, excluded);
    if (!best) return false;
    set.delete(best);
    if (set.size === 0) this.state.retiring.delete(nodeId);
    preparePromotedPeer(best);
    setSessionRole(best.session, 'live');
    this.state.live.set(nodeId, best);
    this.armIdle(best);
    this.startPing(best);
    this.deps.sendPeerStatus(best);
    this.deps.notifyTransport(nodeId);
    this.deps.notifyLive(nodeId, best.session);
    this.emitLinkInfo(best);
    return true;
  }

  private armDcHealth(live: LivePeer, peerNodeId: string): void {
    if (!live.dcAttemptId) return;
    this.deps.armDcHealthTimer(peerNodeId, live.dcAttemptId);
    this.armUnstableClear(live);
  }

  clearUnstableStreak(peer?: string): void {
    if (peer) this.unstableDc.noteHealthy(peer);
    else this.unstableDc.clearAll();
  }

  private armUnstableClear(live: LivePeer): void {
    armUnstableHealthyTimer(this.state, this.unstableDc, this.unstableClear, live);
  }

  private clearUnstableTimer(peer: string): void {
    clearUnstableHealthyTimer(this.unstableClear, peer);
  }

  private armDcProof(live: LivePeer): void {
    bindLiveDcProof(live, () => {
      if (this.state.live.get(live.peerNodeId) !== live) return;
      this.releaseRetireHold(live.peerNodeId);
    });
  }

  private noteMuxProof(live: LivePeer): void {
    noteLiveDcProof(live, () => this.releaseRetireHold(live.peerNodeId));
  }

  private releaseRetireHold(nodeId: string): void {
    const set = this.state.retiring.get(nodeId);
    if (!set) return;
    for (const row of set) this.deps.maybeFinishRetire(row);
  }
}
