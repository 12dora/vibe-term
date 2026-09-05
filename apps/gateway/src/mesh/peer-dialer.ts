import {
  LinkMux,
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  type WebSocketTransportInput,
} from '@tmex/shared/link';
import { formatSafeErrorLog } from '../auth/cookies';
import {
  type RankableIfaceAddr,
  addressFromIceCandidate,
  hostFromWsUrl,
  localNetworkFingerprint,
  rankPeerEndpoints,
} from './address-class';
import { dcFailureReason as describeDcFailure } from './direct-failure-codes';
import { stamp } from './mesh-log';
import { parseEndpoints } from './peer-dc-upgrade';
import {
  type DialRaceLeg,
  dcDialAborted,
  raceForegroundDial,
  raceWsSecureDial,
  settleAbandonedDcDial,
} from './peer-dial-race';
import {
  type DirectAttemptRecord,
  clearedDirectAttempt,
  dcRecentlyFailed,
  eligiblePeerEndpoints,
  emptyDirectAttempt,
  hasDirectFailure,
  noteDcOutcome,
  noteNoEndpoints,
  noteWsRaceFailure,
} from './peer-direct-attempt';
import { canonicalEndpointSet, dedupeRankedPeerEndpoints } from './peer-endpoint-backoff';
import {
  PEER_LAN_DIAL_TIMEOUT_MS,
  PEER_TRANSPORT_RANK,
  PEER_WS_DIAL_STAGGER_MS,
  type PeerManagerState,
  peerStale,
  throwIfPeerStopped,
} from './peer-manager-state';
import type { PeerLinkFactory } from './peer-manager-types';
import { handshakeRelay, handshakeWsDirect } from './peer-protocol';
import { type DirectDialLimiter, abortable, quiet } from './peer-ws-race';
import type { RtcPeerManager } from './rtc';
import type { RtcSignaling } from './rtc/ice';
import {
  type RtcDialBreaker,
  classifyRtcDialFailure,
  isIntentionalDcLoss,
} from './rtc/rtc-dial-breaker';
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
    dcAttemptId?: string | null
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

async function ensureRtcReady(rtc: RtcPeerManager): Promise<void> {
  if ((await rtc.ready?.()) === false) throw new Error('node-datachannel is not available');
}

/** 出站拨号：DC / ws-secure 竞速、中继回退、入站握手接纳，以及直连失败的记账。 */
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
    return this.dcCapable(nodeId) && this.deps.dcBreaker.shouldTry(nodeId).allow;
  }

  forceDcProbe(nodeId: string): void {
    if (this.state.stopped) return;
    this.deps.dcBreaker.forceProbe(nodeId);
    const live = this.state.live.get(nodeId);
    if (live) this.deps.maybeUpgrade(nodeId, { cooldown: false });
    else void this.deps.getLink(nodeId).catch(() => undefined);
  }

  async forceProbe(nodeId: string, endpoints?: string[]): Promise<LinkSession | null> {
    this.deps.requireTrusted(nodeId);
    if (this.state.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
    const gen = this.state.generation;
    const attempt = emptyDirectAttempt(this.state.scheduler.now());
    try {
      const session = await this.dialWsSecure(nodeId, gen, this.state.stopAbort.signal, attempt, {
        bypassBackoff: true,
        endpoints,
      });
      this.finishDirectAttempt(nodeId, attempt, session, null);
      return session;
    } catch (err) {
      this.finishDirectAttempt(nodeId, attempt, null, null);
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
    signal: AbortSignal
  ): Promise<LinkSession | null> {
    const rtc = this.rtc;
    if (!rtc) return null;
    const attemptId = this.deps.nextDcAttemptId();
    this.deps.dcBreaker.beginAttempt(nodeId, attemptId);
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
      connectP = rtc.connectToPeer(nodeId, wrapped);
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
        attemptId
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
      const noteDcFailure = (reason: string) => {
        if (this.state.stopped || isIntentionalDcLoss(reason)) return;
        this.deps.dcBreaker.noteFailure(nodeId, classifyRtcDialFailure(reason), attemptId);
      };
      if (dcDialAborted(err)) settleAbandonedDcDial(connectP, noteDcFailure);
      else noteDcFailure(err instanceof Error ? err.message : String(err));
      this.releaseRtcAttempt(nodeId, unsub);
      throw err;
    } finally {
      this.deps.releaseRtcWakeAttempt(nodeId);
    }
  }

  async dial(nodeId: string, opts?: { foreground?: boolean }): Promise<LinkSession> {
    await Promise.resolve();
    const gen = this.state.generation;
    const signal = this.state.stopAbort.signal;
    const existingLive = this.state.live.get(nodeId);
    const floor = existingLive ? PEER_TRANSPORT_RANK[existingLive.transport] : 0;
    const skipDcFirst = !existingLive && this.state.lostDirect.has(nodeId);
    let dcError: unknown = null;
    let dcCoolingUntil: number | null | undefined;
    const attempt = emptyDirectAttempt(this.state.scheduler.now());
    const above = (kind: PeerTransportKind) => PEER_TRANSPORT_RANK[kind] > floor;
    const tryDc = async (dcSignal: AbortSignal): Promise<LinkSession | null> => {
      if (!above('dc') || !this.dcCapable(nodeId)) return null;
      const decision = this.deps.dcBreaker.shouldTry(nodeId);
      if (!decision.allow) {
        dcCoolingUntil = decision.until;
        rtcLog('dial failed', {
          peer: nodeId,
          cause: 'breaker_cooling',
          until: decision.until,
        });
        return null;
      }
      try {
        return await this.dialDc(nodeId, gen, dcSignal);
      } catch (err) {
        dcError = err;
        rtcLog('dial failed', {
          peer: nodeId,
          reason: err instanceof Error ? err.message : String(err),
        });
        throwIfPeerStopped(this.state, nodeId, gen, err);
        return null;
      }
    };
    const tryWs = async (wsSignal: AbortSignal) =>
      above('ws-secure') ? await this.dialWsSecure(nodeId, gen, wsSignal, attempt) : null;
    const direct = await this.dialDirect(nodeId, gen, signal, {
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
    this.finishDirectAttempt(nodeId, attempt, direct.session, dcError, dcCoolingUntil);
    if (direct.session) return direct.session;
    try {
      const stream = await this.state.uplink.openRelay(nodeId);
      const result = await handshakeRelay({
        stream,
        role: 'initiator',
        identity: this.state.identity,
        userStore: this.state.userStore,
      });
      if (result.peerNodeId !== nodeId) {
        result.session.close('peer-id-mismatch');
        throw new NodeUnreachableError(nodeId, 'relay peer id mismatch');
      }
      this.rememberKeys(result.session, result.sendKey, result.recvKey);
      const kept = this.deps.track(
        result.session,
        result.peerNodeId,
        'relay',
        this.state.identity.nodeId,
        gen
      );
      if (!kept) throw new NodeUnreachableError(nodeId, 'simultaneous-dial');
      return kept;
    } catch (err) {
      // 中继也不通：竞速超时后仍在跑的直连腿是最后一根稻草，等它把话说完。
      const late = direct.pending ? await direct.pending : null;
      if (late) return late;
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
  }

  /** 直连阶段：前台走 DC/ws-secure 竞速，后台升级仍是原来的顺序拨号（DC 拿满 15 s）。 */
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
        live: () => this.state.live.get(nodeId)?.session ?? null,
        close: (session, reason) => quiet(() => session.close(reason)),
        log: (event, fields) => rtcLog(event, { peer: nodeId, ...fields }),
      });
      if (raced.session) return { session: raced.session, pending: null };
      throwIfPeerStopped(this.state, nodeId, gen);
      return { session: await liveOf(), pending: raced.pending };
    }
    const steps = legs.skipDcFirst
      ? [legs.tryWs, liveOf, legs.tryDc, liveOf]
      : [legs.tryDc, legs.tryWs, liveOf];
    for (const step of steps) {
      const got = await step(signal);
      if (got) return { session: got, pending: null };
      throwIfPeerStopped(this.state, nodeId, gen);
    }
    return { session: null, pending: null };
  }

  private async dialWsSecure(
    nodeId: string,
    gen: number,
    signal: AbortSignal,
    attempt: DirectAttemptRecord,
    opts?: { bypassBackoff?: boolean; endpoints?: string[] }
  ): Promise<LinkSession | null> {
    if (this.linkFactory && !opts?.endpoints) {
      try {
        const session = await abortable(Promise.resolve(this.linkFactory(nodeId, signal)), signal);
        if (session) {
          if (peerStale(this.state, gen)) {
            quiet(() => session.close('stopped'));
            throw new NodeUnreachableError(nodeId, 'peer manager stopped');
          }
          const kept = this.deps.track(
            session,
            nodeId,
            'ws-secure',
            this.state.identity.nodeId,
            gen,
            false,
            null
          );
          if (kept) return kept;
        }
      } catch (err) {
        throwIfPeerStopped(this.state, nodeId, gen, err);
      }
    }
    const cached = this.state.userStore.getPeer(nodeId);
    const parsed =
      opts?.endpoints ??
      (cached ? parseEndpoints(cached.endpointsJson, this.deps.listenPort()) : []);
    const endpoints = dedupeRankedPeerEndpoints(rankPeerEndpoints(parsed, this.interfacesFn()));
    if (endpoints.length === 0) {
      noteNoEndpoints(attempt);
      return null;
    }
    const eligible = eligiblePeerEndpoints(
      this.state.endpointBackoff,
      nodeId,
      endpoints,
      attempt,
      this.state.scheduler.now(),
      opts?.bypassBackoff
    );
    if (eligible.length === 0) return null;
    const raced = await raceWsSecureDial({
      nodeId,
      gen,
      urls: eligible,
      signal,
      staggerMs: PEER_WS_DIAL_STAGGER_MS,
      connectTimeoutMs: this.connectTimeoutMs,
      lanTimeoutMs: PEER_LAN_DIAL_TIMEOUT_MS,
      identity: this.state.identity,
      userStore: this.state.userStore,
      limiter: this.dialLimiter,
      backoff: this.state.endpointBackoff,
      wsFactory: this.wsFactory,
      stale: (g) => peerStale(this.state, g),
      sleep: (ms, sig) => this.state.scheduler.sleep(ms, sig),
    });
    noteWsRaceFailure(attempt, raced, endpoints);
    if (peerStale(this.state, gen)) {
      quiet(() => raced.winner?.session.close('stopped'));
      throwIfPeerStopped(this.state, nodeId, gen);
    }
    const winner = raced.winner;
    if (!winner) return null;
    this.rememberKeys(winner.session, winner.sendKey, winner.recvKey);
    return this.deps.track(
      winner.session,
      winner.peerNodeId,
      'ws-secure',
      this.state.identity.nodeId,
      gen,
      false,
      hostFromWsUrl(winner.url)
    );
  }

  async acceptDirect(socket: ServerSocketAdapter, remoteAddress: string | null): Promise<void> {
    const gen = this.state.generation;
    try {
      const result = await handshakeWsDirect({
        socket,
        role: 'acceptor',
        identity: this.state.identity,
        userStore: this.state.userStore,
      });
      if (peerStale(this.state, gen)) {
        quiet(() => result.session.close('stopped'));
        return;
      }
      this.rememberKeys(result.session, result.sendKey, result.recvKey);
      this.deps.track(
        result.session,
        result.peerNodeId,
        'ws-secure',
        result.peerNodeId,
        gen,
        false,
        remoteAddress
      );
    } catch {
      quiet(() => socket.close(1000, 'handshake-failed'));
    }
  }

  async acceptRelay(stream: LinkStream, from: string): Promise<void> {
    const gen = this.state.generation;
    try {
      const result = await handshakeRelay({
        stream,
        role: 'acceptor',
        identity: this.state.identity,
        userStore: this.state.userStore,
      });
      if (peerStale(this.state, gen)) {
        quiet(() => result.session.close('stopped'));
        return;
      }
      this.rememberKeys(result.session, result.sendKey, result.recvKey);
      this.deps.track(result.session, result.peerNodeId, 'relay', from || result.peerNodeId, gen);
    } catch (err) {
      console.warn(stamp(`[mesh][relay] accept failed node=${from} ${formatSafeErrorLog(err)}`));
      quiet(() => stream.reset('handshake-failed'));
    }
  }

  private finishDirectAttempt(
    nodeId: string,
    attempt: DirectAttemptRecord,
    session: LinkSession | null,
    dcError: unknown,
    dcCoolingUntil?: number | null
  ): void {
    const live = this.state.live.get(nodeId);
    if (session && live && live.transport !== 'relay') return;
    if (attempt.dc == null) {
      const failure = describeDcFailure(nodeId, dcError, {
        coolingUntil: dcCoolingUntil,
        directCapable: this.state.userStore.getPeer(nodeId)?.directCapable,
        rtcAvailable: this.rtc?.available === true,
      });
      noteDcOutcome(attempt, failure?.text ?? null, failure?.code ?? null, failure?.params ?? null);
    }
    if (hasDirectFailure(attempt))
      this.state.lastDirectAttempt.set(nodeId, { ...attempt, at: this.state.scheduler.now() });
  }

  clearDirectFailure(nodeId: string): void {
    const prev = this.state.lastDirectAttempt.get(nodeId);
    if (prev) this.state.lastDirectAttempt.set(nodeId, clearedDirectAttempt(prev));
  }
}
