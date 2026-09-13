import type { LinkSession, LinkStream } from '@vibeterm/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { WebSocketServer } from '../ws';
import {
  RTT_EVENT_MIN_INTERVAL_MS,
  classifyPeerReach,
  rttChangedMaterially,
} from './address-class';
import type { UpgradeGate } from './peer-dc-upgrade';
import { type PeerInboundStreamHost, handlePeerInboundStream } from './peer-live-inbound';
import {
  applyExistingLive,
  consumeForcedSession,
  earlyTrackResult,
  existingLiveDecision,
} from './peer-live-rank';
import {
  PEER_DC_IDLE_MS,
  PEER_MISSED_PONG_LIMIT,
  PEER_PING_INTERVAL_MS,
  type PeerManagerState,
  applyPeerRttSample,
  comparePeerTransport,
  isPeerTrusted,
  measurePingRttMs,
  parseEchoedSentAt,
  peerStale,
} from './peer-manager-state';
import { parseOpenPayload } from './peer-protocol';
import { type LivePeer, peerDropPlan } from './peer-reconnect-wake';
import { type IncomingWakeGate, PEER_RTC_WAKE_COOLDOWN_MS } from './peer-rtc-wake';
import { quiet } from './peer-ws-race';
import type { TrackIntercept, TrackInterceptInput } from './route-degrade';
import {
  type RtcDialBreaker,
  type RtcDialBreakerSnapshot,
  classifyRtcDialFailure,
  isIntentionalDcLoss,
} from './rtc/rtc-dial-breaker';
import { flushDialFailed } from './rtc/rtc-log';
import { classifyOpenPayload } from './stream-targets';
import type { DispatchHttp, PeerReach, PeerTransportKind } from './types';
import type { GatewaySessionClose } from './ws-stream-target';

export type PeerLiveRegistryDeps = {
  dcBreaker: RtcDialBreaker;
  sendPeerCtl: (live: LivePeer, msg: Record<string, unknown>) => void;
  handlePeerCtl: (live: LivePeer, bytes: Uint8Array) => void;
  sendPeerStatus: (live: LivePeer) => void;
  sendLinkHello: (live: LivePeer) => void;
  restartQuiesce: (live: LivePeer) => void;
  probeQuiesce: (live: LivePeer) => void;
  clearDirectFailure: (nodeId: string) => void;
  parkInbound: (
    peerNodeId: string,
    session: LinkSession,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress: string | null
  ) => void;
  dropParked: (nodeId: string, reason: string) => void;
  activateParked: (nodeId: string) => void;
  retirePeer: (prev: LivePeer, reason: string) => void;
  finishRetire: (live: LivePeer, reason?: string) => void;
  armRetireTimer: (live: LivePeer, reason?: string) => void;
  maybeFinishRetire: (live: LivePeer, reason?: string) => void;
  nextDcAttemptId: () => string;
  armDcHealthTimer: (nodeId: string, attemptId: string) => void;
  cancelDcHealthTimer: (nodeId: string) => void;
  armDcUpgradeRetry: (nodeId: string) => void;
  cancelDcUpgradeRetry: (nodeId: string) => void;
  ensureGate: (nodeId: string) => UpgradeGate;
  ensureIncomingWakeGate: (nodeId: string) => IncomingWakeGate;
  onPeerReconnected: (nodeId: string) => void;
  notifyTransport: (nodeId: string) => void;
  notifyLive: (nodeId: string, session: LinkSession) => void;
  onRttSample: (live: LivePeer, sampleMs: number) => void;
  interceptTrack?: (input: TrackInterceptInput) => TrackIntercept;
};

export type PeerLiveRegistryOptions = {
  idleMs: number;
  maxConcurrentStreams: number;
  sessionStore?: NodeSessionStore;
  dispatchHttp: () => DispatchHttp | undefined;
  wsServer?: WebSocketServer;
  onGatewaySession:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        auth: { sid: string; uid: string; via: string; cid?: string }
      ) => boolean | undefined)
    | null;
  onGatewaySessionClose:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        close?: GatewaySessionClose
      ) => void)
    | null;
  onLinkInfo:
    | ((info: {
        nodeId: string;
        reach: PeerReach;
        transport: PeerTransportKind | null;
        rttMs: number | null;
        dcBreaker?: RtcDialBreakerSnapshot;
      }) => void)
    | null;
  deps: PeerLiveRegistryDeps;
};

export class PeerLiveRegistry {
  private readonly state: PeerManagerState;
  private readonly deps: PeerLiveRegistryDeps;
  private readonly idleMs: number;
  private readonly maxConcurrentStreams: number;
  private readonly sessionStore?: NodeSessionStore;
  private readonly dispatchHttp: () => DispatchHttp | undefined;
  private readonly wsServer?: WebSocketServer;
  private readonly onGatewaySession: PeerLiveRegistryOptions['onGatewaySession'];
  private readonly onGatewaySessionClose: PeerLiveRegistryOptions['onGatewaySessionClose'];
  private readonly onLinkInfo: PeerLiveRegistryOptions['onLinkInfo'];
  private readonly inboundHost: PeerInboundStreamHost;
  private linkInfoHold = 0;
  private readonly bypassRank = new WeakSet<LinkSession>();

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
    if (consumeForcedSession(this.bypassRank, session)) {
      if (prev && prev.session !== session) this.deps.retirePeer(prev, 'replaced');
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
      }),
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
      this.deps.dcBreaker.noteChannelEstablished(peerNodeId, live.dcAttemptId ?? undefined);
      flushDialFailed(peerNodeId, { cause: 'established' });
      if (live.dcAttemptId) this.deps.armDcHealthTimer(peerNodeId, live.dcAttemptId);
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
      const lastFrameAt = live.session.lastFrameAt;
      if (lastFrameAt != null && lastFrameAt > live.lastInboundFrameAt) {
        live.lastInboundFrameAt = lastFrameAt;
        live.missedPongs = 0;
      } else live.missedPongs += 1;
      if (live.missedPongs >= PEER_MISSED_PONG_LIMIT) {
        this.dropPeer(live.peerNodeId, 'missed-pong');
        return;
      }
      sendPing();
    }, PEER_PING_INTERVAL_MS);
  }

  onPeerPong(live: LivePeer, echoedSentAt?: number): void {
    live.missedPongs = 0;
    const sample = measurePingRttMs(performance.now(), echoedSentAt, live.pingSentAt);
    live.pingSentAt = null;
    if (sample == null) return;
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
    if (this.linkInfoHold > 0) return;
    this.onLinkInfo?.({
      nodeId: live.peerNodeId,
      reach: classifyPeerReach(live.transport, live.remoteAddress),
      transport: live.transport,
      rttMs: live.rttMs,
      dcBreaker: this.deps.dcBreaker.snapshot(live.peerNodeId),
    });
  }

  emitOfflineLinkInfo(nodeId: string): void {
    if (this.linkInfoHold > 0) return;
    this.onLinkInfo?.({
      nodeId,
      reach: null,
      transport: null,
      rttMs: null,
      dcBreaker: this.deps.dcBreaker.snapshot(nodeId),
    });
  }

  private maybeEmitRtt(live: LivePeer): void {
    if (!rttChangedMaterially(live.lastEmittedRttMs, live.rttMs)) return;
    const now = this.state.scheduler.now();
    if (live.lastEmittedRttMs != null && now - live.lastRttEmitAt < RTT_EVENT_MIN_INTERVAL_MS) {
      return;
    }
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
    const live = this.state.live.get(nodeId);
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
      this.deps.dcBreaker.noteFailure(
        nodeId,
        classifyRtcDialFailure(reason),
        dcAttemptId ?? undefined
      );
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

  private promoteRetiring(nodeId: string, excluded?: LivePeer | null): boolean {
    if (this.state.live.get(nodeId)) return false;
    const set = this.state.retiring.get(nodeId);
    if (!set || set.size === 0) return false;
    let best: LivePeer | null = null;
    for (const row of set) {
      if (row === excluded || row.finishRetired) continue;
      if (!best || comparePeerTransport(row.transport, best.transport) > 0) best = row;
    }
    if (!best) return false;
    set.delete(best);
    if (set.size === 0) this.state.retiring.delete(nodeId);
    best.retiring = false;
    best.retireReason = 'replaced';
    best.retiredAt = 0;
    best.retireTimer?.clear();
    best.retireTimer = null;
    best.gotQuiesceAck = false;
    best.gotPeerQuiesce = false;
    best.rttMs = null;
    best.pingSentAt = null;
    best.rttSpikeIgnored = false;
    best.rttSamples = 0;
    best.rttMinMs = undefined;
    best.lastEmittedRttMs = null;
    best.lastRttEmitAt = 0;
    this.state.live.set(nodeId, best);
    this.armIdle(best);
    this.startPing(best);
    this.deps.sendPeerStatus(best);
    this.deps.notifyTransport(nodeId);
    this.deps.notifyLive(nodeId, best.session);
    this.emitLinkInfo(best);
    return true;
  }
}
