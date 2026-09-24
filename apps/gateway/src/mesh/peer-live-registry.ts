import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import { classifyPeerReach } from './address-class';
import { type DcPromoteGate, attachDcPromote, mergeTrackIntercept } from './peer-dc-promote-gate';
import {
  UnstableDcBackoff,
  bindLiveDcProof,
  logDcDrop,
  noteLiveDcProof,
  settleEstablishedDcDrop,
  unbindLiveDcProof,
} from './peer-dc-proof';
import { type PeerInboundStreamHost, handlePeerInboundStream } from './peer-live-inbound';
import { notePeerPingTick, shouldEmitPeerRtt } from './peer-live-ping';
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
  parseEchoedSentAt,
  peerStale,
} from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import { type LivePeer, peerDropPlan } from './peer-reconnect-wake';
import { PEER_RTC_WAKE_COOLDOWN_MS } from './peer-rtc-wake';
import * as sideRelay from './peer-side-relay';
import { quiet } from './peer-ws-race';
import { rememberLinkTransport } from './pending-measure-hold';
import { getRelayDialBreaker } from './relay-dial-breaker';
import { RTC_DIAL_BREAKER_HEALTHY_MS, isIntentionalDcLoss } from './rtc/rtc-dial-breaker';
import { flushDialFailed } from './rtc/rtc-log';
import { classifyOpenPayload } from './stream-targets';
import type { PeerTransportKind } from './types';

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
  private readonly dcPromote: DcPromoteGate;
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
    this.dcPromote = attachDcPromote(this as never);
    this.inboundHost = {
      selfNodeId: state.identity.nodeId,
      dispatchHttp: this.dispatchHttp,
      sessionStore: this.sessionStore,
      wsServer: this.wsServer,
      now: () => this.state.scheduler.now(),
      onGatewaySession: this.onGatewaySession,
      onGatewaySessionClose: this.onGatewaySessionClose,
    };
    sideRelay.watchSideRelay(this.state, this.inboundHost, this.maxConcurrentStreams);
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
    const tap = {
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      rtcEpoch,
      prev,
      remoteAddress: resolvedAddress,
      dcAttemptId,
    };
    const early = earlyTrackResult(
      mergeTrackIntercept(this.deps.interceptTrack?.(tap), this.dcPromote.decide(tap)),
      prev,
      (reason) => {
        quiet(() => session.close(reason));
      }
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
    const { session, prev, transport } = input;
    if (sideRelay.shouldParkBesideRelay(this.state, prev, transport) && prev.session !== session) {
      sideRelay.parkBesideRelay(this.state, prev.peerNodeId, session);
      return session;
    }
    if (prev && prev.session !== session) this.deps.retirePeer(prev, 'replaced');
    return this.installLive(
      session,
      input.peerNodeId,
      transport,
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
    rememberLinkTransport(session, transport);
    const keys = this.state.sessionKeys.get(session);
    const live: LivePeer = {
      session,
      peerNodeId,
      transport,
      initiatedBy,
      generation: gen,
      streams: 0,
      lastStreamAt: this.state.scheduler.now(),
      idleTimer: null,
      pingTimer: null,
      missedPongs: 0,
      lastInboundFrameAt: session.lastFrameAt ?? this.state.scheduler.now(),
      retiring: false,
      retireReason: 'replaced',
      retiredAt: 0,
      zeroStreamsSince: 0,
      gotQuiesceAck: false,
      gotPeerQuiesce: false,
      retireTimer: null,
      finishRetired: false,
      lastAdvertisedStatusJson: '',
      unsubRtc: null,
      sendKey: keys?.sendKey,
      recvKey: keys?.recvKey,
      quiesceCapable,
      helloReplied: false,
      probeSent: false,
      remoteAddress,
      rttMs: null,
      pingSentAt: null,
      rttSpikeIgnored: false,
      lastRttEmitAt: 0,
      lastEmittedRttMs: null,
      linkSinceAt: this.state.scheduler.now(),
      dcAttemptId: transport === 'dc' ? (dcAttemptId ?? this.deps.nextDcAttemptId()) : null,
      rttSamples: 0,
      rttMinMs: undefined,
      ...(transport === 'dc' && rtcEpoch !== undefined ? { rtcEpoch } : {}),
    };
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
    this.bindSession(live);
    this.state.peerReconnectWake.installed(live, (nodeId) => this.deps.onPeerReconnected(nodeId));
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

  private bindSession(live: LivePeer): void {
    const { session, peerNodeId } = live;
    const origOpen = session.openStream.bind(session);
    session.openStream = async (openPayload: Uint8Array) => {
      if (live.finishRetired) throw new Error('peer link replaced');
      if (live.streams >= this.maxConcurrentStreams) throw new Error('too-many-streams');
      const stream = await origOpen(openPayload);
      this.onLocalStream(live, stream);
      return stream;
    };
    session.onStream((stream) => {
      const retiringSet = this.state.retiring.get(peerNodeId);
      const isCurrent = this.state.live.get(peerNodeId) === live;
      const isRetiring = live.retiring && retiringSet?.has(live) === true;
      if (!isCurrent && !isRetiring) {
        stream.reset('stale-link');
        return;
      }
      const kind = classifyOpenPayload(stream.openPayload);
      if (kind === 'unknown' || kind === 'relay') {
        stream.reset('unknown-stream-type');
        return;
      }
      if (live.streams >= this.maxConcurrentStreams) {
        stream.reset('too-many-streams');
        return;
      }
      this.onLocalStream(live, stream);
      handlePeerInboundStream(this.inboundHost, peerNodeId, stream);
    });
    session.ctl.onMessage((bytes) => {
      if (this.handleRttCtl(live, bytes)) return;
      this.deps.handlePeerCtl(live, bytes);
    });
    void session.closed.then((info) => {
      const reason = info?.reason ?? 'closed';
      if (this.state.live.get(peerNodeId)?.session === session) {
        this.dropPeer(peerNodeId, reason);
      }
      const set = this.state.retiring.get(peerNodeId);
      if (set) {
        for (const row of [...set]) {
          if (row.session === session) this.deps.finishRetire(row, reason);
        }
      }
    });
  }

  private onLocalStream(live: LivePeer, stream: LinkStream): void {
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
    live.pingTimer?.clear();
    live.missedPongs = 0;
    live.lastInboundFrameAt = live.session.lastFrameAt ?? live.lastInboundFrameAt;
    const sendPing = () => {
      live.pingSentAt = performance.now();
      this.deps.sendPeerCtl(live, { t: 'ping', sentAt: live.pingSentAt });
    };
    live.pingTimer = this.state.scheduler.interval(() => {
      if (this.state.live.get(live.peerNodeId) !== live) return;
      if (
        notePeerPingTick(live, lookupPeerRttMsForLink(live.session, this.state.scheduler)) ===
        'drop'
      ) {
        this.dropPeer(live.peerNodeId, 'missed-pong');
        return;
      }
      sendPing();
    }, PEER_PING_INTERVAL_MS);
  }

  onPeerPong(live: LivePeer, echoedSentAt?: number): void {
    live.missedPongs = 0;
    const answered = live.pingSentAt != null;
    const sample = measurePingRttMs(performance.now(), echoedSentAt, live.pingSentAt);
    live.pingSentAt = null;
    if (sample == null) return;
    if (answered) this.noteMuxProof(live);
    applyPeerRttSample(live, sample);
    this.deps.onRttSample(live, sample);
    this.maybeEmitRtt(live);
  }

  private handleRttCtl(live: LivePeer, bytes: Uint8Array): boolean {
    const msg = parseOpenPayload(bytes);
    if (!msg || typeof msg.t !== 'string') return false;
    if (msg.t === 'ping') {
      const sentAt = parseEchoedSentAt(msg.sentAt);
      this.deps.sendPeerCtl(live, sentAt == null ? { t: 'pong' } : { t: 'pong', sentAt });
      return true;
    }
    if (msg.t !== 'pong') return false;
    this.onPeerPong(live, parseEchoedSentAt(msg.sentAt));
    return true;
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
    const plan = peerDropPlan(live, reason, this.state.stopped, isIntentionalDcLoss(reason));
    const drainLive = plan.drain ? live : null;
    const disabledLiveLost = Boolean(live && this.deps.dcBreaker.isDisabled(nodeId));
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
      this.state.peerReconnectWake.clear(nodeId);
      if (plan.revoked) this.deps.dcBreaker.reset(nodeId);
      this.deps.dropParked(nodeId, reason);
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
    } finally {
      this.linkInfoHold -= 1;
    }
    if (plan.wasDc) this.deps.armDcUpgradeRetry(nodeId);
    const next = this.state.live.get(nodeId);
    this.state.peerReconnectWake.lost(nodeId, disabledLiveLost, Boolean(next));
    if (next) this.emitLinkInfo(next);
    else this.emitOfflineLinkInfo(nodeId);
  }
  private adoptSideRelay(nodeId: string, session: LinkSession): void {
    const id = this.state.identity.nodeId;
    this.installLive(session, nodeId, 'relay', id, this.state.generation, false, null);
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

  private armUnstableClear(live: LivePeer): void {
    this.clearUnstableTimer(live.peerNodeId);
    const peer = live.peerNodeId;
    const attempt = live.dcAttemptId;
    const handle = this.state.scheduler.interval(() => {
      handle.clear();
      this.unstableClear.delete(peer);
      const current = this.state.live.get(peer);
      if (current !== live || current.dcAttemptId !== attempt) return;
      this.unstableDc.noteHealthy(peer);
    }, RTC_DIAL_BREAKER_HEALTHY_MS);
    this.unstableClear.set(peer, handle);
  }

  private clearUnstableTimer(peer: string): void {
    this.unstableClear.get(peer)?.clear();
    this.unstableClear.delete(peer);
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
