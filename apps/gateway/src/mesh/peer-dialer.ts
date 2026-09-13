import {
  LinkMux,
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  type WebSocketTransportInput,
} from '@vibeterm/shared/link';
import {
  type RankableIfaceAddr,
  addressFromIceCandidate,
  localNetworkFingerprint,
} from './address-class';
import { parseEndpoints } from './peer-dc-upgrade';
import { peerKnownRelayOnline, settleDialWithRelay } from './peer-dial-plan';
import { type DialRaceLeg, raceForegroundDial, runBackgroundDirect } from './peer-dial-race';
import { type AcceptDeps, acceptDirectSession, acceptRelaySession } from './peer-dialer-accept';
import {
  ensureRtcReady,
  finishDirectAttemptRecord,
  gateDcDial,
  noteDialDcFailure,
} from './peer-dialer-dc-gate';
import { openPeerRelaySession } from './peer-dialer-relay';
import {
  type DirectAttemptRecord,
  clearedDirectAttempt,
  dcRecentlyFailed,
  emptyDirectAttempt,
  winningDialInitiator,
} from './peer-direct-attempt';
import { canonicalEndpointSet } from './peer-endpoint-backoff';
import {
  PEER_TRANSPORT_RANK,
  type PeerManagerState,
  peerStale,
  throwIfPeerStopped,
} from './peer-manager-state';
import type { PeerLinkFactory } from './peer-manager-types';
import { type DirectDialLimiter, abortable, quiet } from './peer-ws-race';
import {
  type WsSecureDialHost,
  type WsSecureDialOpts,
  connectWsSecure,
  sharePeerDialInflight,
} from './peer-ws-reroll-dial';
import type { RtcPeerManager } from './rtc';
import type { RtcSignaling } from './rtc/ice';
import type { RtcDialBreaker } from './rtc/rtc-dial-breaker';
import { rtcLog } from './rtc/rtc-log';
import { NodeUnreachableError, type PeerTransportKind } from './types';

export type PeerDialerDeps = {
  dcBreaker: RtcDialBreaker;
  track: (
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable?: boolean,
    remoteAddress?: string | null,
    dcAttemptId?: string | null,
    rtcEpoch?: number
  ) => LinkSession | null;
  requireTrusted: (nodeId: string) => void;
  getLink: (nodeId: string) => Promise<LinkSession>;
  maybeUpgrade: (nodeId: string, opts: { cooldown: boolean; userPath?: boolean }) => void;
  nextDcAttemptId: () => string;
  signalingFor: (peerNodeId: string) => RtcSignaling;
  dispatchRtcWake: (peerNodeId: string) => void;
  releaseRtcWakeAttempt: (peerNodeId: string) => void;
  onLocalFingerprintChanged: () => void;
  onPeerEndpointChanged: (nodeId: string) => void;
  listenPort: () => number | undefined;
  allowsOutboundDirect?: (nodeId: string) => boolean;
  allowsInboundDirect?: () => boolean;
  trackRelay?: (session: LinkSession, peerNodeId: string, gen: number) => LinkSession | null;
};

export type PeerDialerOptions = {
  rtc: RtcPeerManager | null;
  linkFactory: PeerLinkFactory | null;
  wsFactory: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  connectTimeoutMs: number;
  dialLimiter: DirectDialLimiter;
  interfacesFn: () => Record<string, RankableIfaceAddr[] | undefined>;
  refreshLocalInterfaces: (() => Record<string, RankableIfaceAddr[] | undefined>) | null;
  deps: PeerDialerDeps;
};

export class PeerDialer {
  private readonly state: PeerManagerState;
  private readonly deps: PeerDialerDeps;
  private readonly rtc: RtcPeerManager | null;
  private readonly linkFactory: PeerLinkFactory | null;
  private readonly wsFactory: (
    url: string
  ) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  private readonly connectTimeoutMs: number;
  private readonly dialLimiter: DirectDialLimiter;
  private readonly interfacesFn: () => Record<string, RankableIfaceAddr[] | undefined>;
  private readonly refreshLocalInterfaces:
    | (() => Record<string, RankableIfaceAddr[] | undefined>)
    | null;
  private localFingerprint = '';
  private readonly dcInflight = new Map<string, Promise<LinkSession | null>>();
  private readonly wsInflight = new Map<string, Promise<LinkSession | null>>();

  constructor(state: PeerManagerState, opts: PeerDialerOptions) {
    this.state = state;
    this.deps = opts.deps;
    this.rtc = opts.rtc;
    this.linkFactory = opts.linkFactory;
    this.wsFactory = opts.wsFactory;
    this.connectTimeoutMs = opts.connectTimeoutMs;
    this.dialLimiter = opts.dialLimiter;
    this.interfacesFn = opts.interfacesFn;
    this.refreshLocalInterfaces = opts.refreshLocalInterfaces;
  }

  hasWsSecureCandidate(nodeId: string): boolean {
    if (this.deps.allowsOutboundDirect && !this.deps.allowsOutboundDirect(nodeId)) return false;
    if (this.linkFactory) return true;
    const cached = this.state.userStore.getPeer(nodeId);
    return cached ? parseEndpoints(cached.endpointsJson, this.deps.listenPort()).length > 0 : false;
  }

  dcCapable(nodeId: string): boolean {
    return (
      this.rtc?.available === true && this.state.userStore.getPeer(nodeId)?.directCapable !== false
    );
  }

  shouldTryDc(nodeId: string): boolean {
    if (this.deps.allowsOutboundDirect && !this.deps.allowsOutboundDirect(nodeId)) return false;
    return this.dcCapable(nodeId) && this.deps.dcBreaker.shouldTry(nodeId).allow;
  }

  forceDcProbe(nodeId: string): void {
    if (this.state.stopped) return;
    this.deps.dcBreaker.forceProbe(nodeId);
    const live = this.state.live.get(nodeId);
    if (live) this.deps.maybeUpgrade(nodeId, { cooldown: false });
    else void this.deps.getLink(nodeId).catch(() => undefined);
  }

  hasDcInflight(nodeId: string): boolean {
    return this.dcInflight.has(nodeId);
  }

  hasWsRerollInflight(nodeId: string): boolean {
    return this.wsInflight.has(nodeId);
  }

  /** 直连重掷：DC 绕过 wantsUpgrade；ws-secure 走 raced factory。answer 仅 DC 应答侧。 */
  dialDcReroll(
    nodeId: string,
    opts?: { answer?: boolean; transport?: 'dc' | 'ws-secure' }
  ): Promise<LinkSession | null> {
    const transport = opts?.transport ?? this.state.live.get(nodeId)?.transport;
    if (transport === 'ws-secure') return this.dialWsReroll(nodeId);
    const answer = opts?.answer === true;
    const self = this.state.identity.nodeId.toLowerCase();
    const peer = nodeId.toLowerCase();
    const ok =
      !this.state.stopped &&
      this.state.live.get(nodeId)?.transport === 'dc' &&
      this.dcCapable(nodeId) &&
      (answer ? self > peer : self < peer) &&
      (answer
        ? this.deps.dcBreaker.shouldAcceptAnswer?.(nodeId) !== false
        : this.deps.dcBreaker.shouldTry(nodeId).allow);
    if (!ok) return Promise.resolve(null);
    const { generation, stopAbort } = this.state;
    return this.dialDc(nodeId, generation, stopAbort.signal, 'upgrade', answer);
  }

  dialWsReroll(nodeId: string): Promise<LinkSession | null> {
    const live = this.state.live.get(nodeId);
    const blocked =
      this.state.stopped ||
      live?.transport !== 'ws-secure' ||
      winningDialInitiator(this.state.identity.nodeId, nodeId) !== this.state.identity.nodeId;
    if (blocked || !live) return Promise.resolve(null);
    const attempt = emptyDirectAttempt(this.state.scheduler.now());
    return this.dialWsSecure(nodeId, this.state.generation, this.state.stopAbort.signal, attempt, {
      mode: 'reroll',
      expectedLive: live.session,
    }).catch(() => null);
  }

  async forceProbe(nodeId: string, endpoints?: string[]): Promise<LinkSession | null> {
    this.deps.requireTrusted(nodeId);
    if (this.state.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
    const gen = this.state.generation;
    const attempt = emptyDirectAttempt(this.state.scheduler.now());
    const rtcOn = this.rtc?.available === true;
    const done = (session: LinkSession | null) =>
      finishDirectAttemptRecord(this.state, nodeId, attempt, session, null, undefined, rtcOn);
    try {
      const session = await this.dialWsSecure(nodeId, gen, this.state.stopAbort.signal, attempt, {
        bypassBackoff: true,
        endpoints,
      });
      done(session);
      return session;
    } catch (err) {
      done(null);
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
  }

  syncLocalFingerprint(): void {
    const next = localNetworkFingerprint(
      this.refreshLocalInterfaces ? this.refreshLocalInterfaces() : this.interfacesFn()
    );
    if (this.localFingerprint && next !== this.localFingerprint) {
      this.state.endpointBackoff.resetAll();
      this.state.uplink.resetBackoff();
      this.deps.onLocalFingerprintChanged();
    }
    this.localFingerprint = next;
  }

  syncPeerEndpointSet(nodeId: string): void {
    const cached = this.state.userStore.getPeer(nodeId);
    const urls = cached ? parseEndpoints(cached.endpointsJson, this.deps.listenPort()) : [];
    const next = canonicalEndpointSet(urls);
    const prev = this.state.advertisedEndpointSet.get(nodeId);
    if (prev !== undefined && prev !== next) {
      this.state.endpointBackoff.resetNode(nodeId);
      this.deps.onPeerEndpointChanged(nodeId);
    }
    this.state.advertisedEndpointSet.set(nodeId, next);
  }

  private rememberKeys(session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array): void {
    if (!sendKey || !recvKey) return;
    this.state.sessionKeys.set(session, { sendKey, recvKey });
  }

  private releaseRtcAttempt(peerNodeId: string, unsub: (() => void) | null): void {
    unsub?.();
    this.state.rtcInbox.delete(peerNodeId);
  }

  private async dialDc(
    nodeId: string,
    gen: number,
    signal: AbortSignal,
    mode: 'foreground' | 'upgrade',
    peerInitiated: boolean
  ): Promise<LinkSession | null> {
    const existing = this.dcInflight.get(nodeId);
    if (existing) return mode === 'foreground' ? existing : null;
    let settle!: (value: LinkSession | null) => void;
    const held = new Promise<LinkSession | null>((resolve) => {
      settle = resolve;
    });
    this.dcInflight.set(nodeId, held);
    try {
      const result = await this.runDialDc(nodeId, gen, signal, peerInitiated);
      settle(result);
      return result;
    } catch (err) {
      settle(null);
      throw err;
    } finally {
      this.dcInflight.delete(nodeId);
      this.deps.releaseRtcWakeAttempt(nodeId);
    }
  }

  private async runDialDc(
    nodeId: string,
    gen: number,
    signal: AbortSignal,
    peerInitiated: boolean
  ): Promise<LinkSession | null> {
    const rtc = this.rtc;
    if (!rtc) return null;
    const attemptId = this.deps.nextDcAttemptId();
    this.deps.dcBreaker.beginAttempt(nodeId, attemptId);
    const ice = rtc.currentIceConfig?.() ?? { stun: [] as string[], turn: null };
    const signaling = this.deps.signalingFor(nodeId);
    let unsub: (() => void) | null = null;
    const wrapped: RtcSignaling = {
      send: (msg) => signaling.send(msg),
      onMessage: (cb) => {
        unsub = signaling.onMessage(cb);
        return unsub;
      },
    };
    let connectP: Promise<Awaited<ReturnType<RtcPeerManager['connectToPeer']>>> | null = null;
    try {
      await ensureRtcReady(rtc);
      throwIfPeerStopped(this.state, nodeId, gen);
      connectP = rtc.connectToPeer(nodeId, wrapped, { attemptId, signal });
      this.deps.dispatchRtcWake(nodeId);
      const result = await abortable(connectP, signal);
      if (peerStale(this.state, gen)) {
        this.releaseRtcAttempt(nodeId, unsub);
        unsub = null;
        quiet(() => result.pc.close());
        throw new Error('stopped');
      }
      const session = new LinkMux(result.link, {
        role: result.role,
        logContext: { nodeId: result.peerNodeId, transport: 'dc' },
      });
      const initiatedBy =
        result.role === 'initiator' ? this.state.identity.nodeId : result.peerNodeId;
      const pair = result.pc.getSelectedCandidatePair?.();
      const remoteAddress =
        pair?.remote?.address ?? addressFromIceCandidate(pair?.remote?.candidate) ?? null;
      const kept = this.deps.track(
        session,
        result.peerNodeId,
        'dc',
        initiatedBy,
        gen,
        false,
        remoteAddress,
        attemptId,
        result.epoch
      );
      if (kept === session) {
        const live = this.state.live.get(result.peerNodeId);
        if (live) live.unsubRtc = unsub;
        unsub = null;
        return kept;
      }
      this.releaseRtcAttempt(nodeId, unsub);
      unsub = null;
      return kept;
    } catch (err) {
      const reason = noteDialDcFailure({
        stopped: this.state.stopped,
        nodeId,
        err,
        connectP,
        attemptId,
        peerInitiated,
        dcBreaker: this.deps.dcBreaker,
      });
      this.releaseRtcAttempt(nodeId, unsub);
      rtcLog('dial failed', {
        peer: nodeId,
        reason,
        stun_count: ice.stun.length,
        turn: Boolean(ice.turn),
        attempt: attemptId,
      });
      throw err;
    }
  }

  async dialRelayOnly(nodeId: string): Promise<LinkSession> {
    const gen = this.state.generation;
    const existing = this.state.live.get(nodeId);
    if (existing?.transport === 'relay') return existing.session;
    return openPeerRelaySession({
      host: this.state,
      nodeId,
      gen,
      rememberKeys: (session, sendKey, recvKey) => this.rememberKeys(session, sendKey, recvKey),
      track: (session, id, g) =>
        this.deps.trackRelay
          ? this.deps.trackRelay(session, id, g)
          : this.deps.track(session, id, 'relay', this.state.identity.nodeId, g),
    });
  }

  async dial(
    nodeId: string,
    opts?: { foreground?: boolean; peerInitiated?: boolean }
  ): Promise<LinkSession> {
    const peerInitiated = opts?.peerInitiated === true;
    const allowDirect = peerInitiated
      ? this.deps.allowsInboundDirect?.() !== false
      : this.deps.allowsOutboundDirect?.(nodeId) !== false;
    if (!allowDirect) return this.dialRelayOnly(nodeId);
    const existingLive = this.state.live.get(nodeId);
    const floor = existingLive ? PEER_TRANSPORT_RANK[existingLive.transport] : 0;
    await Promise.resolve();
    const gen = this.state.generation;
    const signal = this.state.stopAbort.signal;
    const skipDcFirst = !peerInitiated && !existingLive && this.state.lostDirect.has(nodeId);
    let dcError: unknown = null;
    let dcCoolingUntil: number | null | undefined;
    const attempt = emptyDirectAttempt(this.state.scheduler.now());
    const above = (kind: PeerTransportKind) => PEER_TRANSPORT_RANK[kind] > floor;
    const tryDc = async (dcSignal: AbortSignal): Promise<LinkSession | null> => {
      const gate = gateDcDial({
        peer: nodeId,
        capable: this.dcCapable(nodeId),
        aboveDc: above('dc'),
        peerInitiated,
        decision: this.deps.dcBreaker.shouldTry(nodeId),
      });
      if (!gate.allow) {
        dcCoolingUntil = gate.coolingUntil;
        return null;
      }
      try {
        return await this.dialDc(
          nodeId,
          gen,
          dcSignal,
          opts?.foreground ? 'foreground' : 'upgrade',
          peerInitiated
        );
      } catch (err) {
        dcError = err;
        throwIfPeerStopped(this.state, nodeId, gen, err);
        return null;
      }
    };
    const tryWs = async (wsSignal: AbortSignal) =>
      above('ws-secure') ? await this.dialWsSecure(nodeId, gen, wsSignal, attempt) : null;
    const directP = this.dialDirect(nodeId, gen, signal, {
      tryDc,
      tryWs,
      wsFirst:
        skipDcFirst ||
        dcRecentlyFailed(
          this.state.lastDirectAttempt.get(nodeId),
          this.state.scheduler.now(),
          this.deps.dcBreaker.snapshot(nodeId).failures
        ),
      skipDcFirst,
      foreground: opts?.foreground === true,
    });
    const rtcOn = this.rtc?.available === true;
    return settleDialWithRelay({
      nodeId,
      raceRelay:
        opts?.foreground === true &&
        !existingLive &&
        peerKnownRelayOnline({
          nodeId,
          relaysFor: (id) => this.state.relayPresence?.relaysFor(id) ?? [],
          onlineUnion: () => this.state.relayPresence?.onlineUnion() ?? new Set(),
        }),
      direct: directP,
      startRelay: (sig) =>
        openPeerRelaySession({
          host: this.state,
          nodeId,
          gen,
          rememberKeys: (session, sendKey, recvKey) => this.rememberKeys(session, sendKey, recvKey),
          track: (session, id, g) =>
            this.deps.track(session, id, 'relay', this.state.identity.nodeId, g),
          signal: sig,
        }),
      onDirectSettled: (direct) =>
        finishDirectAttemptRecord(
          this.state,
          nodeId,
          attempt,
          direct.session,
          dcError,
          dcCoolingUntil,
          rtcOn
        ),
    });
  }

  /** 直连阶段：前台走 DC/ws-secure 竞速；后台升级两条腿并行，ws-secure 不等 DC 超时。 */
  private async dialDirect(
    nodeId: string,
    gen: number,
    signal: AbortSignal,
    legs: {
      tryDc: DialRaceLeg<LinkSession>;
      tryWs: DialRaceLeg<LinkSession>;
      wsFirst: boolean;
      skipDcFirst: boolean;
      foreground: boolean;
    }
  ): Promise<{ session: LinkSession | null; pending: Promise<LinkSession | null> | null }> {
    const liveOf = async () => this.state.live.get(nodeId)?.session ?? null;
    if (legs.foreground) {
      const raced = await raceForegroundDial<LinkSession>({
        dc: legs.tryDc,
        ws: legs.tryWs,
        wsFirst: legs.wsFirst,
        signal,
        scheduler: this.state.scheduler,
        nodeId,
        live: () => this.state.live.get(nodeId)?.session ?? null,
        close: (session, reason) => quiet(() => session.close(reason)),
        log: (event, fields) => rtcLog(event, { peer: nodeId, ...fields }),
        connectTimeoutMs: this.connectTimeoutMs,
      });
      if (raced.session) return { session: raced.session, pending: null };
      throwIfPeerStopped(this.state, nodeId, gen);
      return { session: await liveOf(), pending: raced.pending };
    }
    return runBackgroundDirect({
      dc: legs.tryDc,
      ws: legs.tryWs,
      skipDcFirst: legs.skipDcFirst,
      signal,
      liveOf,
      throwIfStopped: () => throwIfPeerStopped(this.state, nodeId, gen),
    });
  }

  private wsHost(): WsSecureDialHost {
    return {
      state: this.state,
      linkFactory: this.linkFactory,
      wsFactory: this.wsFactory,
      connectTimeoutMs: this.connectTimeoutMs,
      dialLimiter: this.dialLimiter,
      interfacesFn: this.interfacesFn,
      listenPort: this.deps.listenPort,
      rememberKeys: (session, sendKey, recvKey) => this.rememberKeys(session, sendKey, recvKey),
      track: this.deps.track,
    };
  }

  private dialWsSecure(
    nodeId: string,
    gen: number,
    signal: AbortSignal,
    attempt: DirectAttemptRecord,
    opts?: WsSecureDialOpts
  ): Promise<LinkSession | null> {
    return sharePeerDialInflight(
      this.wsInflight,
      nodeId,
      opts?.mode === 'reroll' ? 'background' : 'foreground',
      () => connectWsSecure(this.wsHost(), nodeId, gen, signal, attempt, opts)
    );
  }

  async acceptDirect(socket: ServerSocketAdapter, remoteAddress: string | null): Promise<void> {
    await acceptDirectSession(this.acceptDeps(), socket, remoteAddress);
  }

  async acceptRelay(stream: LinkStream, from: string, viaRelay?: string): Promise<void> {
    await acceptRelaySession(this.acceptDeps(), stream, from, viaRelay);
  }

  private acceptDeps(): AcceptDeps {
    return {
      state: this.state,
      track: this.deps.track,
      rememberKeys: (session, sendKey, recvKey) => this.rememberKeys(session, sendKey, recvKey),
    };
  }

  clearDirectFailure(nodeId: string): void {
    const prev = this.state.lastDirectAttempt.get(nodeId);
    if (prev) this.state.lastDirectAttempt.set(nodeId, clearedDirectAttempt(prev));
  }
}
