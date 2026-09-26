import {
  LinkMux,
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  type WebSocketTransportInput,
} from '@vibeterm/shared/link';
import { type RankableIfaceAddr, addressFromIceCandidate } from './address-class';
import { parseEndpoints } from './peer-dc-upgrade';
import { peerKnownRelayOnline, settleDialWithRelay } from './peer-dial-plan';
import { type DialRaceLeg, raceForegroundDial, runBackgroundDirect } from './peer-dial-race';
import { type AcceptDeps, acceptDirectSession, acceptRelaySession } from './peer-dialer-accept';
import {
  dcRerollPermitted,
  installFinishedDc,
  noteDcDialFailure,
  rerollSessionCurrent,
} from './peer-dialer-dc-finish';
import { ensureRtcReady, finishDirectAttemptRecord, gateDcDial } from './peer-dialer-dc-gate';
import {
  dialRelayOnlySession,
  dialRelayUntrackedSession,
  forceProbeDirect,
  syncDialerFingerprint,
  syncDialerPeerEndpoints,
} from './peer-dialer-probe';
import { openPeerRelaySession } from './peer-dialer-relay';
import type { PeerDialerDeps, PeerDialerOptions } from './peer-dialer-types';
import {
  type DirectAttemptRecord,
  clearedDirectAttempt,
  dcRecentlyFailed,
  emptyDirectAttempt,
  winningDialInitiator,
} from './peer-direct-attempt';
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
import { rtcLog } from './rtc/rtc-log';
import type { PeerTransportKind } from './types';

export type { PeerDialerDeps, PeerDialerOptions } from './peer-dialer-types';

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
  private readonly dcAbort = new Map<string, AbortController>();
  private readonly dcRerollPeers = new Set<string>();
  private readonly dcExpectedLive = new Map<string, LinkSession>();
  private readonly dcRemoteSdp = new Set<string>();
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

  abortDcInflight(nodeId: string): void {
    this.dcAbort.get(nodeId)?.abort(new DOMException('paused', 'AbortError'));
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
    if (
      !dcRerollPermitted({
        stopped: this.state.stopped,
        liveTransport: this.state.live.get(nodeId)?.transport,
        dcCapable: this.dcCapable(nodeId),
        answer,
        selfLower: this.state.identity.nodeId.toLowerCase(),
        peerLower: nodeId.toLowerCase(),
        breakerAllows: this.deps.dcBreaker.shouldTry(nodeId).allow,
        degraded: this.deps.isDegraded?.(nodeId) === true,
      })
    ) {
      return Promise.resolve(null);
    }
    if (this.dcInflight.has(nodeId)) return this.dcInflight.get(nodeId) ?? Promise.resolve(null);
    this.dcRerollPeers.add(nodeId);
    const live = this.state.live.get(nodeId);
    if (live) this.dcExpectedLive.set(nodeId, live.session);
    const { generation, stopAbort } = this.state;
    return this.dialDc(nodeId, generation, stopAbort.signal, 'upgrade', answer).finally(() => {
      this.dcRerollPeers.delete(nodeId);
      this.dcExpectedLive.delete(nodeId);
    });
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
    return forceProbeDirect(this.probeCtx(), nodeId, endpoints);
  }

  syncLocalFingerprint(): void {
    syncDialerFingerprint(this.probeCtx());
  }

  syncPeerEndpointSet(nodeId: string): void {
    syncDialerPeerEndpoints(this.probeCtx(), nodeId);
  }

  private probeCtx() {
    return {
      state: this.state,
      deps: this.deps,
      rtc: this.rtc,
      fingerprint: () => this.localFingerprint,
      setFingerprint: (next: string) => {
        this.localFingerprint = next;
      },
      interfaces: () =>
        this.refreshLocalInterfaces ? this.refreshLocalInterfaces() : this.interfacesFn(),
      dialWs: this.dialWsSecure.bind(this),
    };
  }

  private rememberKeys(session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array): void {
    if (!sendKey || !recvKey) return;
    this.state.sessionKeys.set(session, { sendKey, recvKey });
  }

  private rerollStillCurrent(nodeId: string): boolean {
    return rerollSessionCurrent({
      reroll: this.dcRerollPeers.has(nodeId),
      degraded: this.deps.isDegraded?.(nodeId) === true,
      expected: this.dcExpectedLive.get(nodeId),
      live: this.state.live.get(nodeId)?.session,
    });
  }

  private finishDcDial(input: {
    gen: number;
    unsub: (() => void) | null;
    result: { peerNodeId: string; epoch?: number };
    attemptId: string;
    session: LinkSession;
    initiatedBy: string;
    remoteAddress: string | null;
  }): LinkSession | null {
    const id = input.result.peerNodeId;
    return installFinishedDc({
      ...input,
      reroll: this.dcRerollPeers.has(id),
      offer: this.deps.offerCandidate,
      liveSession: () => this.state.live.get(id)?.session ?? null,
      track: this.deps.track,
      release: (sub) => this.releaseRtcAttempt(id, sub),
      attach: (sub) => {
        const live = this.state.live.get(id);
        if (live) live.unsubRtc = sub;
      },
    });
  }

  private releaseRtcAttempt(_peerNodeId: string, unsub: (() => void) | null): void {
    unsub?.();
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
    const child = new AbortController();
    const relay = () => child.abort(signal.reason);
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
    this.dcAbort.set(nodeId, child);
    try {
      const result = await this.runDialDc(nodeId, gen, child.signal, peerInitiated);
      settle(result);
      return result;
    } catch (err) {
      settle(null);
      throw err;
    } finally {
      signal.removeEventListener('abort', relay);
      if (this.dcAbort.get(nodeId) === child) this.dcAbort.delete(nodeId);
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
    this.dcRemoteSdp.delete(nodeId);
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
      connectP = rtc.connectToPeer(nodeId, wrapped, {
        attemptId,
        signal,
        onRemoteSdpApplied: () => this.dcRemoteSdp.add(nodeId),
      });
      this.deps.dispatchRtcWake(nodeId, { gated: true });
      const result = await abortable(connectP, signal);
      if (!this.rerollStillCurrent(nodeId)) throw new Error('reroll-stale');
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
      return this.finishDcDial({
        gen,
        unsub,
        result,
        attemptId,
        session,
        initiatedBy,
        remoteAddress,
      });
    } catch (err) {
      const reason = noteDcDialFailure({
        stopped: this.state.stopped,
        nodeId,
        err,
        connectP,
        attemptId,
        peerInitiated,
        reroll: this.dcRerollPeers.has(nodeId),
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

  async dialRelayUntracked(nodeId: string): Promise<LinkSession> {
    return dialRelayUntrackedSession(this.state, (s, a, b) => this.rememberKeys(s, a, b), nodeId);
  }

  async dialRelayOnly(nodeId: string, opts?: { background?: boolean }): Promise<LinkSession> {
    return dialRelayOnlySession(
      this.state,
      this.deps,
      (s, a, b) => this.rememberKeys(s, a, b),
      nodeId,
      opts
    );
  }

  async dial(
    nodeId: string,
    opts?: { foreground?: boolean; peerInitiated?: boolean; skipDc?: boolean }
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
        capable: opts?.skipDc === true ? false : this.dcCapable(nodeId),
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
        dcSdpApplied: () => this.dcRemoteSdp.has(nodeId),
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
