import os from 'node:os';
import type { LinkSession } from '@tmex/shared/link';
import { classifyPeerReach } from './address-class';
import { defaultScheduler, encodeJsonBytes } from './ctl';
import type { RtcSignalMessage } from './mesh-deps';
import { DcUpgradeCoordinator, PeerCollaboratorHost } from './peer-dc-upgrade';
import { PeerDialer } from './peer-dialer';
import { directFailureView, winningDialInitiator } from './peer-direct-attempt';
import { PeerEndpointBackoff } from './peer-endpoint-backoff';
import { PeerLinkDrain } from './peer-link-drain';
import { PeerLinkWaiters } from './peer-link-waiters';
import { PeerLiveRegistry } from './peer-live-registry';
import {
  PEER_CONNECT_TIMEOUT_MS,
  PEER_IDLE_MS,
  PEER_MAX_CONCURRENT_STREAMS,
  type PeerManagerState,
  RTC_PEER_INBOX_MAX_MESSAGES,
  createPeerManagerState,
  isPeerTrusted,
} from './peer-manager-state';
import type { PeerLinkDetail, PeerManagerOptions, TransportWaiter } from './peer-manager-types';
import { parseOpenPayload } from './peer-protocol';
import type { LivePeer } from './peer-reconnect-wake';
import {
  type RtcSignalInboxEntry,
  RtcWakeGate,
  deliverRtcSignal,
  shouldDropUnboundRtcSignal,
  shouldStartRtcAttempt,
} from './peer-rtc-wake';
import { PeerServer } from './peer-server';
import { PeerStatusSync } from './peer-status-sync';
import { quiet, sharedDirectDialLimiter } from './peer-ws-race';
import { isRtcWakeSdp } from './rtc/ice';
import { rtcLog } from './rtc/rtc-log';
import {
  type DispatchHttp,
  type MeshIdentity,
  NodeUnreachableError,
  type PeerReach,
  type PeerTransportKind,
} from './types';

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

  constructor(opts: PeerManagerOptions) {
    super();
    let scheduler = opts.scheduler ?? defaultScheduler();
    if (opts.now) {
      const now = opts.now;
      const inner = scheduler;
      scheduler = {
        now,
        sleep: inner.sleep.bind(inner),
        interval: inner.interval.bind(inner),
      };
    }
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
    this.dcUpgrade = new DcUpgradeCoordinator({
      scheduler,
      live: () => this.state.live,
      dialDc: (nodeId) => this.dialer.dial(nodeId),
      shouldTryDc: (nodeId) => this.dialer.shouldTryDc(nodeId),
      dcCapable: (nodeId) => this.dialer.dcCapable(nodeId),
      emitLinkInfo: (live) => this.registry.emitLinkInfo(live as LivePeer),
      log: rtcLog,
      stopped: () => this.state.stopped,
      stopSignal: () => this.state.stopAbort.signal,
      isTrusted: (nodeId) => this.isTrusted(nodeId),
      pending: () => this.state.pending,
      upgrading: () => this.state.upgrading,
      probeQuiesce: (live) => this.drain.probeQuiesce(live as LivePeer),
      hasWsSecureCandidate: (nodeId) => this.dialer.hasWsSecureCandidate(nodeId),
      lostDirect: () => this.state.lostDirect,
    });
    this.rtcWake = new RtcWakeGate({
      identity: this.identity,
      userStore: opts.userStore,
      scheduler,
      sendRtcSignal: (peerNodeId, msg) => this.rtcWake.sendRtcSignal(peerNodeId, msg),
      dcCapable: (nodeId) => this.dialer.dcCapable(nodeId),
      maybeUpgrade: (nodeId, upgradeOpts) => this.maybeUpgrade(nodeId, upgradeOpts),
      stopSignal: () => this.state.stopAbort.signal,
      stopped: () => this.state.stopped,
      isTrusted: (nodeId) => this.isTrusted(nodeId),
      live: () => this.state.live,
      shouldTryDc: (nodeId) => this.dialer.shouldTryDc(nodeId),
      pending: () => this.state.pending,
      upgrading: () => this.state.upgrading,
      wantsUpgrade: (live) => this.wantsUpgrade(live as LivePeer),
      getLink: (nodeId) => this.getLink(nodeId),
      rtcListeners: () => this.rtcListeners,
      rtcInbox: () => this.state.rtcInbox,
      sendPeerCtl: (live, payload) => this.sendPeerCtl(live as LivePeer, payload),
      ensureDcSession: this.ensureDcSession,
      uplinkSendCtl: (payload) => this.state.uplink.sendCtl(payload),
    });
    this.statusSync = new PeerStatusSync(this.state, {
      keyLogApplier: opts.keyLogApplier,
      statusProvider: opts.statusProvider,
      deps: {
        sendPeerCtl: (live, msg) => this.sendPeerCtl(live, msg),
        notifyPeerEndpointsChanged: (nodeId) => this.notifyPeerEndpointsChanged(nodeId),
        listenPort: () => this.server?.port,
      },
    });
    this.waiters = new PeerLinkWaiters(this.state, {
      maybeUpgrade: (nodeId, upgradeOpts) => this.maybeUpgrade(nodeId, upgradeOpts),
    });
    this.drain = new PeerLinkDrain(this.state, {
      clearIdle: (live) => this.registry.clearIdle(live),
      sendPeerCtl: (live, msg) => this.sendPeerCtl(live, msg),
      maybeUpgrade: (nodeId, upgradeOpts) => this.maybeUpgrade(nodeId, upgradeOpts),
      armDcUpgradeRetry: (nodeId) => this.armDcUpgradeRetry(nodeId),
      onPeerReconnected: (nodeId) => this.dcUpgrade.onPeerReconnected(nodeId),
      hasCoalescedUpgrade: (nodeId) => this.dcUpgrade.upgradeGate.get(nodeId)?.coalesced === true,
      track: (...args) => this.registry.track(...args),
    });
    this.registry = new PeerLiveRegistry(this.state, {
      idleMs: opts.idleMs ?? PEER_IDLE_MS,
      maxConcurrentStreams: opts.maxConcurrentStreams ?? PEER_MAX_CONCURRENT_STREAMS,
      sessionStore: opts.sessionStore,
      dispatchHttp: () => this.dispatchHttp,
      wsServer: opts.wsServer,
      onGatewaySession: opts.onGatewaySession ?? null,
      onGatewaySessionClose: opts.onGatewaySessionClose ?? null,
      onLinkInfo: opts.onLinkInfo ?? null,
      deps: {
        dcBreaker: this.dcUpgrade.dcBreaker,
        sendPeerCtl: (live, msg) => this.sendPeerCtl(live, msg),
        handlePeerCtl: (live, bytes) => this.handlePeerCtl(live, bytes),
        sendPeerStatus: (live) => this.statusSync.sendPeerStatus(live),
        sendLinkHello: (live) => this.drain.sendLinkHello(live),
        restartQuiesce: (live) => this.drain.restartQuiesce(live),
        probeQuiesce: (live) => this.drain.probeQuiesce(live),
        clearDirectFailure: (nodeId) => this.dialer.clearDirectFailure(nodeId),
        parkInbound: (peerNodeId, session, transport, initiatedBy, gen, remoteAddress) =>
          this.drain.parkInbound(peerNodeId, session, transport, initiatedBy, gen, remoteAddress),
        dropParked: (nodeId, reason) => this.drain.dropParked(nodeId, reason),
        activateParked: (nodeId) => this.drain.activateParked(nodeId),
        retirePeer: (prev, reason) => this.drain.retirePeer(prev, reason),
        finishRetire: (live, reason) => this.drain.finishRetire(live, reason),
        armRetireTimer: (live, reason) => this.drain.armRetireTimer(live, reason),
        maybeFinishRetire: (live, reason) => this.drain.maybeFinishRetire(live, reason),
        nextDcAttemptId: () => this.nextDcAttemptId(),
        armDcHealthTimer: (nodeId, attemptId) => this.armDcHealthTimer(nodeId, attemptId),
        cancelDcHealthTimer: (nodeId) => this.cancelDcHealthTimer(nodeId),
        armDcUpgradeRetry: (nodeId) => this.armDcUpgradeRetry(nodeId),
        cancelDcUpgradeRetry: (nodeId) => this.cancelDcUpgradeRetry(nodeId),
        ensureGate: (nodeId) => this.ensureGate(nodeId),
        ensureIncomingWakeGate: (nodeId) => this.ensureIncomingWakeGate(nodeId),
        onPeerReconnected: (nodeId) => this.dcUpgrade.onPeerReconnected(nodeId),
        notifyTransport: (nodeId) => this.waiters.notifyTransport(nodeId),
        notifyLive: (nodeId, session) => this.waiters.notifyLive(nodeId, session),
      },
    });
    this.dialer = new PeerDialer(this.state, {
      rtc: opts.rtc ?? null,
      linkFactory: opts.linkFactory ?? null,
      wsFactory: opts.wsFactory ?? ((url: string) => new WebSocket(url)),
      connectTimeoutMs: opts.connectTimeoutMs ?? PEER_CONNECT_TIMEOUT_MS,
      dialLimiter: opts.dialLimiter ?? sharedDirectDialLimiter(),
      interfacesFn: opts.interfacesFn ?? (() => os.networkInterfaces()),
      refreshLocalInterfaces: opts.refreshLocalInterfaces ?? null,
      deps: {
        dcBreaker: this.dcUpgrade.dcBreaker,
        track: (...args) => this.registry.track(...args),
        requireTrusted: (nodeId) => this.requireTrusted(nodeId),
        getLink: (nodeId) => this.getLink(nodeId),
        maybeUpgrade: (nodeId, upgradeOpts) => this.maybeUpgrade(nodeId, upgradeOpts),
        nextDcAttemptId: () => this.nextDcAttemptId(),
        signalingFor: (peerNodeId) => this.signalingFor(peerNodeId),
        dispatchRtcWake: (peerNodeId) => this.dispatchRtcWake(peerNodeId),
        releaseRtcWakeAttempt: (peerNodeId) => this.releaseRtcWakeAttempt(peerNodeId),
        onLocalFingerprintChanged: () => this.dcUpgrade.onLocalFingerprintChanged(),
        onPeerEndpointChanged: (nodeId) => this.dcUpgrade.onPeerEndpointChanged(nodeId),
        listenPort: () => this.server?.port,
      },
    });
    this.state.uplink.setOnRelayStream((stream, from) => {
      void this.dialer.acceptRelay(stream, from);
    });
    if (opts.startServer === false) {
      this.server = null;
    } else {
      this.server = new PeerServer({
        port: opts.peerPort,
        hostname: opts.hostname,
        scheduler,
        onAccept: (socket, remoteIp) => {
          void this.dialer.acceptDirect(socket, remoteIp === 'unknown' ? null : remoteIp);
        },
      });
    }
  }

  private get dcBreaker() {
    return this.dcUpgrade.dcBreaker;
  }

  get listenPort(): number | null {
    return this.server?.listening ? this.server.port : null;
  }
  quiesceCapableOf(nodeId: string): boolean {
    return this.state.live.get(nodeId)?.quiesceCapable === true;
  }

  async start(): Promise<void> {
    await this.server?.start();
    this.dialer.syncLocalFingerprint();
    this.dcUpgrade.startScan(() => {
      this.dialer.syncLocalFingerprint();
      this.state.endpointBackoff.prune();
      this.refreshAdvertisedStatus();
      this.notifyPeerEndpointsChanged();
    });
  }

  async stop(): Promise<void> {
    if (this.state.stopped) return;
    this.state.stopped = true;
    this.state.generation += 1;
    this.state.stopAbort.abort();
    this.dcUpgrade.clearScan();
    this.statusSync.dispose();
    this.server?.stop();
    for (const nodeId of [...this.state.parked.keys()]) {
      this.drain.dropParked(nodeId, 'stopped');
    }
    for (const peer of [...this.state.live.values()]) {
      this.registry.dropPeer(peer.peerNodeId, 'stopped');
    }
    for (const nodeId of [...this.state.retiring.keys()]) {
      this.drain.forceCloseRetiring(nodeId, 'stopped');
    }
    this.rtcListeners.clear();
    this.state.rtcInbox.clear();
    for (const [nodeId, waiters] of this.state.transportWaiters) {
      for (const waiter of waiters) waiter.resolve(false);
      this.state.transportWaiters.delete(nodeId);
    }
    this.state.liveWaiters.clear();
    this.state.upgrading.clear();
    this.rtcWake.dispose();
    this.state.lostDirect.clear();
    this.state.peerReconnectWake.reset();
    this.dcUpgrade.dispose();
  }

  getLive(nodeId: string): LinkSession | null {
    if (!this.isTrusted(nodeId)) {
      if (this.state.userStore.getCert(nodeId)?.revokedLogSeq != null) {
        this.onRevoked(nodeId);
      }
      return null;
    }
    return this.state.live.get(nodeId)?.session ?? null;
  }

  transportOf(nodeId: string): PeerTransportKind | null {
    return this.state.live.get(nodeId)?.transport ?? null;
  }
  rttOf(nodeId: string): number | null {
    return this.state.live.get(nodeId)?.rttMs ?? null;
  }

  linkDetailOf(nodeId: string): PeerLinkDetail {
    const live = this.state.live.get(nodeId);
    return {
      peerAddress: live?.transport === 'relay' ? this.hubHostOf() : (live?.remoteAddress ?? null),
      linkSinceAt: live?.linkSinceAt ?? null,
      endpoints: [],
      directFailure: directFailureView(this.state.lastDirectAttempt.get(nodeId)),
      dcBreaker: this.dcBreaker.snapshot(nodeId),
    };
  }

  onHubSwitched(): void {
    if (this.state.stopped) return;
    this.dcUpgrade.onHubSwitched();
  }

  forceDcProbe(nodeId: string): void {
    this.dialer.forceDcProbe(nodeId);
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
    if (msg.from === 'browser') {
      this.onBrowserSignal?.(msg, fromNodeId);
      return;
    }
    if (!this.isTrusted(fromNodeId)) return;
    if (isRtcWakeSdp(msg.sdp)) {
      this.handleIncomingRtcWake(fromNodeId, msg);
      return;
    }
    if (deliverRtcSignal(this.rtcListeners.get(fromNodeId), msg)) return;
    const pending = this.state.pending.has(fromNodeId);
    const upgrading = this.state.upgrading.has(fromNodeId);
    if (
      shouldDropUnboundRtcSignal({
        selfNodeId: this.identity.nodeId,
        fromNodeId,
        message: msg,
        attemptExists: pending || upgrading,
      })
    ) {
      return;
    }
    const inbox = this.state.rtcInbox.get(fromNodeId) ?? [];
    if (inbox.length >= RTC_PEER_INBOX_MAX_MESSAGES) return;
    inbox.push({ message: msg, receivedAt: this.state.scheduler.now() });
    this.state.rtcInbox.set(fromNodeId, inbox);
    const live = this.state.live.get(fromNodeId);
    if (
      shouldStartRtcAttempt({
        allow: this.dialer.shouldTryDc(fromNodeId),
        pending,
        upgrading,
        live: Boolean(live),
        wantsUpgrade: live ? this.wantsUpgrade(live) : false,
      })
    ) {
      void this.getLink(fromNodeId).catch(() => undefined);
    }
  }

  async getLink(nodeId: string): Promise<LinkSession> {
    if (this.state.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
    this.requireTrusted(nodeId);
    const existing = this.state.live.get(nodeId);
    if (existing) {
      this.maybeUpgrade(nodeId, { cooldown: true, userPath: true });
      return existing.session;
    }
    const inflight = this.state.pending.get(nodeId);
    if (inflight) return this.waiters.awaitEstablishedOrDial(nodeId, inflight);
    const attempt = this.dialer.dial(nodeId, { foreground: true });
    this.state.pending.set(nodeId, attempt);
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (this.state.pending.get(nodeId) === attempt) this.state.pending.delete(nodeId);
      });
    try {
      const session = await this.waiters.awaitEstablishedOrDial(nodeId, attempt);
      // 竞速的败者还在收尾，但链路已经建好：pending 不该再挡住 forceDcProbe / 后台升级。
      const live = this.state.live.has(nodeId);
      if (live && this.state.pending.get(nodeId) === attempt) this.state.pending.delete(nodeId);
      return session;
    } catch (err) {
      const live = this.state.live.get(nodeId);
      if (live) return live.session;
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
  }

  onRevoked(nodeId: string): void {
    this.drain.dropParked(nodeId, 'revoked');
    this.registry.dropPeer(nodeId, 'revoked');
    this.drain.forceCloseRetiring(nodeId, 'revoked');
    this.state.userStore.deletePeer(nodeId);
    this.dcUpgrade.upgradeGate.delete(nodeId);
    this.rtcWake.forgetPeer(nodeId);
    this.cancelDcUpgradeRetry(nodeId);
    this.state.lostDirect.delete(nodeId);
    this.state.lastDirectAttempt.delete(nodeId);
    this.state.upgrading.delete(nodeId);
    this.state.liveWaiters.delete(nodeId);
    this.waiters.failTransportWaiters(nodeId);
    this.state.endpointBackoff.resetNode(nodeId);
    this.state.advertisedEndpointSet.delete(nodeId);
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
    return this.dialer.forceProbe(nodeId, endpoints);
  }

  refreshAdvertisedStatus(): void {
    this.statusSync.refreshAdvertisedStatus();
  }

  notifyKeyLogHeadChanged(): void {
    this.statusSync.notifyKeyLogHeadChanged();
  }

  listReach(): Map<string, PeerReach> {
    const out = new Map<string, PeerReach>();
    for (const peer of this.state.userStore.listPeers()) {
      if (!this.isTrusted(peer.nodeId)) continue;
      out.set(peer.nodeId, null);
    }
    for (const [id, live] of this.state.live) {
      if (!this.isTrusted(id)) {
        if (this.state.userStore.getCert(id)?.revokedLogSeq != null) this.onRevoked(id);
        continue;
      }
      out.set(id, classifyPeerReach(live.transport, live.remoteAddress));
    }
    return out;
  }

  private runCtlAsync(kind: string, peer: string, work: () => Promise<void>): void {
    void work().catch((err) => {
      rtcLog('ctl failed', {
        peer,
        kind,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private isTrusted(nodeId: string): boolean {
    return isPeerTrusted(this.state, nodeId);
  }

  private requireTrusted(nodeId: string): void {
    const cert = this.state.userStore.getCert(nodeId);
    if (cert?.revokedLogSeq != null) {
      this.onRevoked(nodeId);
      throw new NodeUnreachableError(nodeId, 'revoked');
    }
    if (!cert || !this.state.uplink.userId || cert.userId !== this.state.uplink.userId) {
      throw new NodeUnreachableError(nodeId, 'not admitted');
    }
  }

  private handlePeerCtl(live: LivePeer, bytes: Uint8Array): void {
    const msg = parseOpenPayload(bytes);
    if (!msg || typeof msg.t !== 'string') return;
    const t = msg.t;
    const asyncCtl = {
      'node.status': () => this.statusSync.applyPeerStatus(live, msg),
      'key.log.req': () => this.statusSync.serveKeyLog(live, msg),
      'key.log.res': () => this.statusSync.applyKeyLogRes(msg),
    } as const;
    const work = asyncCtl[t as keyof typeof asyncCtl];
    if (work) this.runCtlAsync(t, live.peerNodeId, work);
    else if (t === 'ping') this.sendPeerCtl(live, { t: 'pong' });
    else if (t === 'pong') this.registry.onPeerPong(live);
    else if (t === 'link.hello') {
      if ((Array.isArray(msg.caps) ? msg.caps : []).includes('quiesce')) {
        this.drain.markQuiesceCapable(live);
      }
      if (!live.helloReplied) {
        live.helloReplied = true;
        this.drain.sendLinkHello(live);
      }
    } else if (t === 'link.quiesce.probe') {
      this.drain.markQuiesceCapable(live);
      this.sendPeerCtl(live, { t: 'link.quiesce.probe.ack' });
    } else if (t === 'link.quiesce.probe.ack') this.drain.markQuiesceCapable(live);
    else if (t === 'link.quiesce' || t === 'link.quiesce.ack') {
      if (t === 'link.quiesce') {
        live.gotPeerQuiesce = true;
        this.sendPeerCtl(live, { t: 'link.quiesce.ack' });
      } else live.gotQuiesceAck = true;
      this.drain.markQuiesceCapable(live);
      if (live.retiring) this.drain.maybeFinishRetire(live);
    } else if (t === 'rtc.signal') {
      const signal: RtcSignalMessage = {
        rtcSession: typeof msg.rtcSession === 'string' ? msg.rtcSession : '',
        from: msg.from === 'browser' ? 'browser' : 'node',
        to: typeof msg.to === 'string' ? msg.to : '',
        sdp: typeof msg.sdp === 'string' ? msg.sdp : null,
        candidate: typeof msg.candidate === 'string' ? msg.candidate : null,
      };
      if (signal.from === 'browser') this.onBrowserSignal?.(signal, live.peerNodeId);
      else this.receiveRtcSignal(live.peerNodeId, signal);
    }
  }

  private sendPeerCtl(live: LivePeer, msg: Record<string, unknown>): void {
    quiet(() => {
      void Promise.resolve(live.session.ctl.send(encodeJsonBytes(msg))).catch(() => undefined);
    });
  }
}
