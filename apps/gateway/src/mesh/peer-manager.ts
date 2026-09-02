import os from 'node:os';
import { decodeBase64url, decodeCertificate, encodeBase64url } from '@tmex/shared/auth';
import {
  LinkMux,
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  type WebSocketTransportInput,
} from '@tmex/shared/link';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserStore } from '../auth/user-store';
import type { WebSocketServer } from '../ws';
import {
  RTT_EVENT_MIN_INTERVAL_MS,
  type RankableIfaceAddr,
  addressFromIceCandidate,
  classifyPeerReach,
  classifyRemoteAddress,
  hostFromWsUrl,
  localNetworkFingerprint,
  rankPeerEndpoints,
  rttChangedMaterially,
} from './address-class';
import {
  backoffDelayMs,
  defaultScheduler,
  encodeJsonBytes,
  isRecord,
  jsonStable,
  parseSeq,
} from './ctl';
import { jsonText } from './json-text';
import type { RtcSignalMessage } from './mesh-deps';
import {
  type DirectAttemptRecord,
  clearedDirectAttempt,
  directFailureView,
  emptyDirectAttempt,
  hasDirectFailure,
  noteDcOutcome,
  noteWsOutcome,
  winningDialInitiator,
} from './peer-direct-attempt';
import { PeerEndpointBackoff, canonicalEndpointSet } from './peer-endpoint-backoff';
import { handshakeRelay, handshakeWsDirect, parseOpenPayload } from './peer-protocol';
import { PeerServer } from './peer-server';
import {
  type DirectDialLimiter,
  abortable,
  classifyWsDialFailure,
  dialWsSecureCandidate,
  quiet,
  raceWsSecureEndpoints,
  sharedDirectDialLimiter,
} from './peer-ws-race';
import type { RtcPeerManager } from './rtc';
import {
  RTC_WAKE_DOMAIN,
  RTC_WAKE_MAX_SKEW_MS,
  type RtcSignaling,
  type RtcWakeFields,
  encodeRtcWakeSdp,
  isCanonicalRtcWakeNonce,
  isRtcWakeSdp,
  parseRtcWakeSdp,
  peerRtcSession,
  verifyRtcWakeSignature,
} from './rtc/ice';
import {
  RTC_DIAL_BREAKER_HEALTHY_MS,
  type RtcDialBreaker,
  type RtcDialBreakerSnapshot,
  classifyRtcDialFailure,
  createGatewayRtcDialBreaker,
  isIntentionalDcLoss,
} from './rtc/rtc-dial-breaker';
import { flushDialFailed, rtcLog, rtcLogRateLimited } from './rtc/rtc-log';
import { acceptHttpStream, acceptWsStream, classifyOpenPayload } from './stream-targets';
import {
  type DispatchHttp,
  type KeyLogApplier,
  type MeshIdentity,
  type MeshScheduler,
  NodeUnreachableError,
  type PeerReach,
  type PeerTransportKind,
  type UplinkStatus,
} from './types';
import type { UplinkClient } from './uplink-client';
import type { UplinkPool } from './uplink-pool';

export const PEER_IDLE_MS = 5 * 60 * 1000;
export const PEER_CONNECT_TIMEOUT_MS = 3_000;
export const PEER_LAN_DIAL_TIMEOUT_MS = 4_000;
export const PEER_WS_DIAL_STAGGER_MS = 250;
export const PEER_PING_INTERVAL_MS = 15_000;
export const PEER_MISSED_PONG_LIMIT = 3;
export const PEER_MAX_CONCURRENT_STREAMS = 256;
export const PEER_UPGRADE_COOLDOWN_MS = 10_000;
export const PEER_UPGRADE_SCAN_MS = 15_000;
export const KEY_LOG_STATUS_DEBOUNCE_MS = 100;
export const PEER_UPGRADE_BACKOFF_CAP_MS = 5 * 60 * 1000;
export const PEER_UPGRADE_MAX_INFLIGHT = 4;
export const PEER_MAX_ENDPOINTS = 16;
export const PEER_MAX_ENDPOINT_LENGTH = 256;
export const PEER_RETIRE_MIN_MS = 5_000;
export const PEER_RETIRE_QUIET_MS = 2_000;
export const PEER_RETIRE_MAX_MS = 30_000;
export const RTC_PEER_INBOX_MAX_MESSAGES = 32;
export const PEER_RTC_WAKE_COOLDOWN_MS = 5_000;
export const PEER_RTC_WAKE_NONCE_CACHE = 256;
export const PEER_RTC_WAKE_VERIFY_BURST = 5;
export const PEER_RTC_WAKE_VERIFY_WINDOW_MS = 5_000;
export const PEER_DC_UPGRADE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;
export const PEER_DC_UPGRADE_RETRY_TAIL_MS = 120_000;
export { winningDialInitiator };
export const PEER_TRANSPORT_RANK: Record<PeerTransportKind, number> = {
  dc: 3,
  'ws-secure': 2,
  relay: 1,
};

export function comparePeerTransport(a: PeerTransportKind, b: PeerTransportKind): number {
  return PEER_TRANSPORT_RANK[a] - PEER_TRANSPORT_RANK[b];
}

export type PeerManagerOptions = {
  identity: MeshIdentity;
  userStore: UserStore;
  uplink: UplinkClient | UplinkPool;
  peerPort: number;
  now?: () => number;
  scheduler?: MeshScheduler;
  keyLogApplier?: KeyLogApplier;
  statusProvider?: () => UplinkStatus & { name?: string };
  sessionStore?: NodeSessionStore;
  dispatchHttp?: DispatchHttp;
  wsServer?: WebSocketServer;
  connectTimeoutMs?: number;
  idleMs?: number;
  hostname?: string | string[];
  wsFactory?: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  startServer?: boolean;
  maxConcurrentStreams?: number;
  rtc?: RtcPeerManager;
  linkFactory?: PeerLinkFactory;
  interfacesFn?: () => Record<string, RankableIfaceAddr[] | undefined>;
  hubHost?: string | null | (() => string | null);
  endpointBackoff?: PeerEndpointBackoff;
  dialLimiter?: DirectDialLimiter;
  onGatewaySession?: (
    session: import('../ws/gateway-session').GatewaySession,
    auth: { sid: string; uid: string; via: string; cid?: string }
  ) => boolean | undefined;
  onGatewaySessionClose?: (session: import('../ws/gateway-session').GatewaySession) => void;
  onBrowserSignal?: (msg: RtcSignalMessage, fromNodeId?: string) => void;
  ensureDcSession?: (peerNodeId: string, rtcSession: string) => void;
  onLinkInfo?: (info: {
    nodeId: string;
    reach: PeerReach;
    transport: PeerTransportKind | null;
    rttMs: number | null;
    dcBreaker?: RtcDialBreakerSnapshot;
  }) => void;
};

export type PeerLinkFactory = (
  peerNodeId: string,
  signal: AbortSignal
) => Promise<LinkSession | null>;

type LivePeer = {
  session: LinkSession;
  peerNodeId: string;
  transport: PeerTransportKind;
  initiatedBy: string;
  generation: number;
  streams: number;
  lastStreamAt: number;
  idleTimer: { clear: () => void } | null;
  pingTimer: { clear: () => void } | null;
  missedPongs: number;
  retiring: boolean;
  retiredAt: number;
  zeroStreamsSince: number;
  gotQuiesceAck: boolean;
  gotPeerQuiesce: boolean;
  retireTimer: { clear: () => void } | null;
  finishRetired: boolean;
  lastAdvertisedStatusJson: string;
  unsubRtc: (() => void) | null;
  sendKey?: Uint8Array;
  recvKey?: Uint8Array;
  quiesceCapable: boolean;
  helloReplied: boolean;
  probeSent: boolean;
  remoteAddress: string | null;
  rttMs: number | null;
  pingSentAt: number | null;
  lastRttEmitAt: number;
  lastEmittedRttMs: number | null;
  linkSinceAt: number;
  dcAttemptId: string | null;
};

type UpgradeGate = {
  nextEligibleAt: number;
  failures: number;
  coalesced: boolean;
  scheduled: boolean;
};

type WakeGate = {
  inflight: boolean;
  nextEligibleAt: number;
  deferredAbort: AbortController | null;
};

type IncomingWakeGate = {
  nextEligibleAt: number;
  verifyTokens: number;
  verifyRefillAt: number;
};

type DcUpgradeRetry = {
  attempt: number;
  abort: AbortController | null;
};

type TransportWaiter = {
  kind: PeerTransportKind;
  resolve: (ok: boolean) => void;
};

type LiveWaiter = {
  resolve: (session: LinkSession) => void;
};

export type PeerLinkDetail = {
  peerAddress: string | null;
  linkSinceAt: number | null;
  endpoints: string[];
  directFailure: { at: number; ws?: string | null; dc?: string | null } | null;
  dcBreaker: RtcDialBreakerSnapshot;
};

type ParkedInbound = {
  session: LinkSession;
  transport: PeerTransportKind;
  initiatedBy: string;
  generation: number;
  at: number;
  timer: { clear: () => void } | null;
  remoteAddress: string | null;
};

export class PeerManager {
  readonly identity: MeshIdentity;
  private readonly userStore: UserStore;
  private readonly uplink: UplinkClient | UplinkPool;
  private readonly scheduler: MeshScheduler;
  private readonly keyLogApplier?: KeyLogApplier;
  private readonly statusProvider?: () => UplinkStatus & { name?: string };
  private readonly sessionStore?: NodeSessionStore;
  private readonly dispatchHttp?: DispatchHttp;
  private readonly wsServer?: WebSocketServer;
  private readonly connectTimeoutMs: number;
  private readonly idleMs: number;
  private readonly maxConcurrentStreams: number;
  private readonly wsFactory: (
    url: string
  ) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  private readonly live = new Map<string, LivePeer>();
  private readonly parked = new Map<string, ParkedInbound>();
  private readonly parkedSessions = new WeakSet<LinkSession>();
  private readonly sessionKeys = new WeakMap<
    LinkSession,
    { sendKey: Uint8Array; recvKey: Uint8Array }
  >();
  private readonly retiring = new Map<string, Set<LivePeer>>();
  private readonly pending = new Map<string, Promise<LinkSession>>();
  private readonly upgrading = new Map<string, Promise<LinkSession>>();
  private readonly liveWaiters = new Map<string, LiveWaiter[]>();
  private readonly rtc: RtcPeerManager | null;
  private readonly linkFactory: PeerLinkFactory | null;
  private readonly onGatewaySession:
    | ((
        session: import('../ws/gateway-session').GatewaySession,
        auth: { sid: string; uid: string; via: string; cid?: string }
      ) => boolean | undefined)
    | null;
  private readonly onGatewaySessionClose:
    | ((session: import('../ws/gateway-session').GatewaySession) => void)
    | null;
  private readonly onBrowserSignal: ((msg: RtcSignalMessage, fromNodeId?: string) => void) | null;
  private readonly ensureDcSession: ((peerNodeId: string, rtcSession: string) => void) | null;
  private readonly onLinkInfo:
    | ((info: {
        nodeId: string;
        reach: PeerReach;
        transport: PeerTransportKind | null;
        rttMs: number | null;
        dcBreaker?: RtcDialBreakerSnapshot;
      }) => void)
    | null;
  private readonly rtcListeners = new Map<string, Set<(msg: RtcSignalMessage) => void>>();
  private readonly rtcInbox = new Map<string, RtcSignalMessage[]>();
  private readonly server: PeerServer | null;
  private readonly upgradeGate = new Map<string, UpgradeGate>();
  private readonly wakeGate = new Map<string, WakeGate>();
  private readonly incomingWakeGate = new Map<string, IncomingWakeGate>();
  private readonly rtcWakeNonces = new Map<string, Map<string, number>>();
  private readonly dcUpgradeRetry = new Map<string, DcUpgradeRetry>();
  private readonly dcBreaker: RtcDialBreaker;
  private readonly dcHealth = new Map<string, AbortController>();
  private dcAttemptSeq = 0;
  private readonly lostDirect = new Set<string>();
  private readonly lastDirectAttempt = new Map<string, DirectAttemptRecord>();
  private readonly transportWaiters = new Map<string, TransportWaiter[]>();
  private readonly interfacesFn: () => Record<string, RankableIfaceAddr[] | undefined>;
  private readonly hubHostOf: () => string | null;
  private readonly endpointBackoff: PeerEndpointBackoff;
  private readonly dialLimiter: DirectDialLimiter;
  private readonly advertisedEndpointSet = new Map<string, string>();
  private localFingerprint = '';
  private upgradeInflight = 0;
  private linkInfoHold = 0;
  private readonly upgradeWaiters: Array<() => void> = [];
  private upgradeScan: { clear: () => void } | null = null;
  private keyLogStatusDebounce: { clear: () => void } | null = null;
  private stopped = false;
  private generation = 0;
  private stopAbort = new AbortController();

  constructor(opts: PeerManagerOptions) {
    this.identity = opts.identity;
    this.userStore = opts.userStore;
    this.uplink = opts.uplink;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    if (opts.now) {
      const now = opts.now;
      const inner = this.scheduler;
      this.scheduler = {
        now,
        sleep: inner.sleep.bind(inner),
        interval: inner.interval.bind(inner),
      };
    }
    this.keyLogApplier = opts.keyLogApplier;
    this.statusProvider = opts.statusProvider;
    this.sessionStore = opts.sessionStore;
    this.dispatchHttp = opts.dispatchHttp;
    this.wsServer = opts.wsServer;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? PEER_CONNECT_TIMEOUT_MS;
    this.idleMs = opts.idleMs ?? PEER_IDLE_MS;
    this.maxConcurrentStreams = opts.maxConcurrentStreams ?? PEER_MAX_CONCURRENT_STREAMS;
    this.wsFactory = opts.wsFactory ?? ((url: string) => new WebSocket(url));
    this.rtc = opts.rtc ?? null;
    this.linkFactory = opts.linkFactory ?? null;
    this.onGatewaySession = opts.onGatewaySession ?? null;
    this.onGatewaySessionClose = opts.onGatewaySessionClose ?? null;
    this.onBrowserSignal = opts.onBrowserSignal ?? null;
    this.ensureDcSession = opts.ensureDcSession ?? null;
    this.onLinkInfo = opts.onLinkInfo ?? null;
    this.interfacesFn = opts.interfacesFn ?? (() => os.networkInterfaces());
    const hubHost = opts.hubHost;
    this.hubHostOf = typeof hubHost === 'function' ? hubHost : () => hubHost ?? null;
    this.endpointBackoff =
      opts.endpointBackoff ?? new PeerEndpointBackoff({ now: () => this.scheduler.now() });
    this.dialLimiter = opts.dialLimiter ?? sharedDirectDialLimiter();
    this.dcBreaker = createGatewayRtcDialBreaker({ now: () => this.scheduler.now() });
    this.uplink.setOnRelayStream((stream, from) => {
      void this.acceptRelay(stream, from);
    });
    if (opts.startServer === false) {
      this.server = null;
    } else {
      this.server = new PeerServer({
        port: opts.peerPort,
        hostname: opts.hostname,
        scheduler: this.scheduler,
        onAccept: (socket, remoteIp) => {
          void this.acceptDirect(socket, remoteIp === 'unknown' ? null : remoteIp);
        },
      });
    }
  }

  get listenPort(): number | null {
    if (!this.server?.listening) return null;
    return this.server.port;
  }

  quiesceCapableOf(nodeId: string): boolean {
    return this.live.get(nodeId)?.quiesceCapable === true;
  }

  async start(): Promise<void> {
    await this.server?.start();
    this.syncLocalFingerprint();
    this.upgradeScan?.clear();
    this.upgradeScan = this.scheduler.interval(() => {
      this.syncLocalFingerprint();
      this.endpointBackoff.prune();
      this.refreshAdvertisedStatus();
      this.notifyPeerEndpointsChanged();
    }, PEER_UPGRADE_SCAN_MS);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.stopAbort.abort();
    this.upgradeScan?.clear();
    this.upgradeScan = null;
    this.keyLogStatusDebounce?.clear();
    this.keyLogStatusDebounce = null;
    this.server?.stop();
    for (const nodeId of [...this.parked.keys()]) {
      this.dropParked(nodeId, 'stopped');
    }
    for (const peer of [...this.live.values()]) {
      this.dropPeer(peer.peerNodeId, 'stopped');
    }
    for (const nodeId of [...this.retiring.keys()]) {
      this.forceCloseRetiring(nodeId, 'stopped');
    }
    this.rtcListeners.clear();
    this.rtcInbox.clear();
    for (const [nodeId, waiters] of this.transportWaiters) {
      for (const waiter of waiters) waiter.resolve(false);
      this.transportWaiters.delete(nodeId);
    }
    this.liveWaiters.clear();
    this.upgrading.clear();
    this.abortDeferredRtcWakes();
    this.wakeGate.clear();
    this.incomingWakeGate.clear();
    this.rtcWakeNonces.clear();
    for (const nodeId of [...this.dcUpgradeRetry.keys()]) this.cancelDcUpgradeRetry(nodeId);
    for (const nodeId of [...this.dcHealth.keys()]) this.cancelDcHealthTimer(nodeId);
    this.lostDirect.clear();
    this.dcBreaker.reset();
  }

  getLive(nodeId: string): LinkSession | null {
    if (!this.isTrusted(nodeId)) {
      if (this.userStore.getCert(nodeId)?.revokedLogSeq != null) {
        this.onRevoked(nodeId);
      }
      return null;
    }
    return this.live.get(nodeId)?.session ?? null;
  }

  transportOf(nodeId: string): PeerTransportKind | null {
    return this.live.get(nodeId)?.transport ?? null;
  }

  rttOf(nodeId: string): number | null {
    return this.live.get(nodeId)?.rttMs ?? null;
  }

  linkDetailOf(nodeId: string): PeerLinkDetail {
    const live = this.live.get(nodeId);
    return {
      peerAddress: live?.transport === 'relay' ? this.hubHostOf() : (live?.remoteAddress ?? null),
      linkSinceAt: live?.linkSinceAt ?? null,
      endpoints: [],
      directFailure: directFailureView(this.lastDirectAttempt.get(nodeId)),
      dcBreaker: this.dcBreaker.snapshot(nodeId),
    };
  }

  forceDcProbe(nodeId: string): void {
    if (this.stopped) return;
    this.dcBreaker.forceProbe(nodeId);
    const live = this.live.get(nodeId);
    if (live) this.maybeUpgrade(nodeId, { cooldown: false });
    else void this.getLink(nodeId).catch(() => undefined);
  }

  async waitForTransport(
    nodeId: string,
    kind: PeerTransportKind,
    timeoutMs: number
  ): Promise<boolean> {
    if (this.transportOf(nodeId) === kind) return true;
    if (this.stopped || timeoutMs <= 0) return false;
    return new Promise((resolve) => {
      let settled = false;
      const timeoutAbort = new AbortController();
      const onStop = () => timeoutAbort.abort();
      this.stopAbort.signal.addEventListener('abort', onStop, { once: true });
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.stopAbort.signal.removeEventListener('abort', onStop);
        timeoutAbort.abort();
        const list = this.transportWaiters.get(nodeId);
        if (list) {
          const next = list.filter((row) => row !== waiter);
          if (next.length > 0) this.transportWaiters.set(nodeId, next);
          else this.transportWaiters.delete(nodeId);
        }
        resolve(ok);
      };
      const waiter: TransportWaiter = { kind, resolve: finish };
      const list = this.transportWaiters.get(nodeId) ?? [];
      list.push(waiter);
      this.transportWaiters.set(nodeId, list);
      void this.scheduler.sleep(timeoutMs, timeoutAbort.signal).then(
        () => finish(false),
        () => {
          if (!settled) finish(false);
        }
      );
    });
  }

  sessionKeysOf(nodeId: string): { sendKey: Uint8Array; recvKey: Uint8Array } | null {
    const live = this.live.get(nodeId);
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
    return this.track(
      session,
      peerNodeId,
      transport,
      initiatedBy ?? peerNodeId,
      this.generation,
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
    const listeners = this.rtcListeners.get(fromNodeId);
    if (listeners && listeners.size > 0) {
      for (const cb of listeners) {
        try {
          cb(msg);
        } catch {
          // listener errors must not break signaling
        }
      }
      return;
    }
    const inbox = this.rtcInbox.get(fromNodeId) ?? [];
    if (inbox.length >= RTC_PEER_INBOX_MAX_MESSAGES) return;
    inbox.push(msg);
    this.rtcInbox.set(fromNodeId, inbox);
    const live = this.live.get(fromNodeId);
    if (
      this.shouldTryDc(fromNodeId) &&
      !this.pending.has(fromNodeId) &&
      !this.upgrading.has(fromNodeId) &&
      (!live || this.wantsUpgrade(live))
    ) {
      void this.getLink(fromNodeId).catch(() => undefined);
    }
  }

  async getLink(nodeId: string): Promise<LinkSession> {
    if (this.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
    this.requireTrusted(nodeId);
    const existing = this.live.get(nodeId);
    if (existing) {
      this.maybeUpgrade(nodeId, { cooldown: true, userPath: true });
      return existing.session;
    }
    const inflight = this.pending.get(nodeId);
    if (inflight) return this.awaitEstablishedOrDial(nodeId, inflight);
    const attempt = this.dial(nodeId);
    this.pending.set(nodeId, attempt);
    void attempt
      .catch(() => undefined)
      .finally(() => {
        if (this.pending.get(nodeId) === attempt) this.pending.delete(nodeId);
      });
    try {
      return await this.awaitEstablishedOrDial(nodeId, attempt);
    } catch (err) {
      const live = this.live.get(nodeId);
      if (live) return live.session;
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
  }

  onRevoked(nodeId: string): void {
    this.dropParked(nodeId, 'revoked');
    this.dropPeer(nodeId, 'revoked');
    this.forceCloseRetiring(nodeId, 'revoked');
    this.userStore.deletePeer(nodeId);
    this.upgradeGate.delete(nodeId);
    this.releaseRtcWakeAttempt(nodeId);
    this.wakeGate.delete(nodeId);
    this.incomingWakeGate.delete(nodeId);
    this.rtcWakeNonces.delete(nodeId.toLowerCase());
    this.cancelDcUpgradeRetry(nodeId);
    this.lostDirect.delete(nodeId);
    this.lastDirectAttempt.delete(nodeId);
    this.upgrading.delete(nodeId);
    this.liveWaiters.delete(nodeId);
    this.failTransportWaiters(nodeId);
    this.endpointBackoff.resetNode(nodeId);
    this.advertisedEndpointSet.delete(nodeId);
  }

  notifyPeerEndpointsChanged(nodeId?: string): void {
    if (nodeId) {
      this.syncPeerEndpointSet(nodeId);
      this.maybeUpgrade(nodeId, { cooldown: true });
      return;
    }
    for (const id of this.live.keys()) {
      this.maybeUpgrade(id, { cooldown: true });
    }
  }

  async forceProbe(nodeId: string, endpoints?: string[]): Promise<LinkSession | null> {
    this.requireTrusted(nodeId);
    if (this.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
    const gen = this.generation;
    const attempt = emptyDirectAttempt(this.scheduler.now());
    try {
      const session = await this.dialWsSecure(nodeId, gen, this.stopAbort.signal, attempt, {
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

  refreshAdvertisedStatus(): void {
    if (!this.statusProvider) return;
    for (const live of this.live.values()) {
      this.sendPeerStatus(live);
    }
  }

  notifyKeyLogHeadChanged(): void {
    if (this.stopped || this.keyLogStatusDebounce) return;
    this.keyLogStatusDebounce = this.scheduler.interval(() => {
      this.keyLogStatusDebounce?.clear();
      this.keyLogStatusDebounce = null;
      this.refreshAdvertisedStatus();
    }, KEY_LOG_STATUS_DEBOUNCE_MS);
  }

  listReach(): Map<string, PeerReach> {
    const out = new Map<string, PeerReach>();
    for (const peer of this.userStore.listPeers()) {
      if (!this.isTrusted(peer.nodeId)) continue;
      out.set(peer.nodeId, null);
    }
    for (const [id, live] of this.live) {
      if (!this.isTrusted(id)) {
        if (this.userStore.getCert(id)?.revokedLogSeq != null) this.onRevoked(id);
        continue;
      }
      out.set(id, classifyPeerReach(live.transport, live.remoteAddress));
    }
    return out;
  }

  private rememberKeys(session: LinkSession, sendKey?: Uint8Array, recvKey?: Uint8Array): void {
    if (!sendKey || !recvKey) return;
    this.sessionKeys.set(session, { sendKey, recvKey });
  }

  private stale(gen: number): boolean {
    return this.stopped || gen !== this.generation;
  }

  private throwIfStopped(nodeId: string, gen: number, err?: unknown): void {
    if (!this.stale(gen)) return;
    throw err instanceof NodeUnreachableError
      ? err
      : new NodeUnreachableError(nodeId, 'peer manager stopped');
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
    const cert = this.userStore.getCert(nodeId);
    if (!cert || cert.revokedLogSeq != null) return false;
    const uid = this.uplink.userId;
    return !!uid && cert.userId === uid;
  }

  private requireTrusted(nodeId: string): void {
    const cert = this.userStore.getCert(nodeId);
    if (cert?.revokedLogSeq != null) {
      this.onRevoked(nodeId);
      throw new NodeUnreachableError(nodeId, 'revoked');
    }
    if (!cert || !this.uplink.userId || cert.userId !== this.uplink.userId) {
      throw new NodeUnreachableError(nodeId, 'not admitted');
    }
  }

  private wantsUpgrade(live: LivePeer): boolean {
    if (live.retiring) return false;
    if (live.transport === 'dc') return false;
    return (
      this.shouldTryDc(live.peerNodeId) ||
      (live.transport === 'relay' && this.hasWsSecureCandidate(live.peerNodeId))
    );
  }

  private ensureGate(nodeId: string): UpgradeGate {
    let gate = this.upgradeGate.get(nodeId);
    if (!gate) {
      gate = { nextEligibleAt: 0, failures: 0, coalesced: false, scheduled: false };
      this.upgradeGate.set(nodeId, gate);
    }
    return gate;
  }

  private noteUpgradeResult(nodeId: string, ok: boolean): void {
    const gate = this.ensureGate(nodeId);
    const now = this.scheduler.now();
    if (ok) {
      gate.failures = 0;
      gate.nextEligibleAt = now + PEER_UPGRADE_COOLDOWN_MS;
      return;
    }
    gate.failures += 1;
    gate.nextEligibleAt =
      now +
      backoffDelayMs(gate.failures - 1, PEER_UPGRADE_COOLDOWN_MS, PEER_UPGRADE_BACKOFF_CAP_MS);
  }

  private scheduleCoalescedUpgrade(nodeId: string): void {
    const gate = this.ensureGate(nodeId);
    if (gate.scheduled || this.stopped) return;
    gate.scheduled = true;
    const wait = Math.max(0, gate.nextEligibleAt - this.scheduler.now());
    void this.scheduler.sleep(wait, this.stopAbort.signal).then(
      () => {
        gate.scheduled = false;
        if (this.stopped) return;
        if (this.scheduler.now() < gate.nextEligibleAt) return;
        if (!this.upgradeGate.get(nodeId)?.coalesced) return;
        this.maybeUpgrade(nodeId, { cooldown: true });
      },
      () => {
        gate.scheduled = false;
      }
    );
  }

  private acquireUpgradeSlot(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('stopped'));
    if (this.upgradeInflight < PEER_UPGRADE_MAX_INFLIGHT) {
      this.upgradeInflight += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        this.stopAbort.signal.removeEventListener('abort', onAbort);
        if (this.stopped) {
          reject(new Error('stopped'));
          return;
        }
        this.upgradeInflight += 1;
        resolve();
      };
      const onAbort = () => {
        const idx = this.upgradeWaiters.indexOf(waiter);
        if (idx >= 0) this.upgradeWaiters.splice(idx, 1);
        reject(this.stopAbort.signal.reason ?? new Error('stopped'));
      };
      this.upgradeWaiters.push(waiter);
      this.stopAbort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseUpgradeSlot(): void {
    this.upgradeInflight = Math.max(0, this.upgradeInflight - 1);
    const next = this.upgradeWaiters.shift();
    next?.();
  }

  private maybeUpgrade(nodeId: string, opts: { cooldown: boolean; userPath?: boolean }): void {
    if (this.stopped) return;
    if (!this.isTrusted(nodeId)) return;
    const live = this.live.get(nodeId);
    if (!live || !this.wantsUpgrade(live)) return;
    if (!live.quiesceCapable) {
      this.probeQuiesce(live);
      this.ensureGate(nodeId).coalesced = true;
      return;
    }
    if (this.pending.has(nodeId) || this.upgrading.has(nodeId)) {
      this.ensureGate(nodeId).coalesced = true;
      return;
    }
    const gate = this.ensureGate(nodeId);
    if (opts.cooldown && this.scheduler.now() < gate.nextEligibleAt) {
      gate.coalesced = true;
      this.scheduleCoalescedUpgrade(nodeId);
      return;
    }
    gate.coalesced = false;
    this.queueUpgrade(nodeId);
  }

  private queueUpgrade(nodeId: string): void {
    if (this.upgrading.has(nodeId)) {
      this.ensureGate(nodeId).coalesced = true;
      return;
    }
    const before = this.live.get(nodeId)?.session ?? null;
    const upgrade = this.runUpgradeDial(nodeId, before);
    this.upgrading.set(nodeId, upgrade);
    void upgrade
      .catch(() => undefined)
      .finally(() => {
        if (this.upgrading.get(nodeId) === upgrade) this.upgrading.delete(nodeId);
        if (this.upgradeGate.get(nodeId)?.coalesced && !this.stopped) {
          this.scheduleCoalescedUpgrade(nodeId);
        }
      });
  }

  private async runUpgradeDial(nodeId: string, before: LinkSession | null): Promise<LinkSession> {
    await this.acquireUpgradeSlot();
    try {
      const session = await this.dial(nodeId);
      this.noteUpgradeResult(nodeId, session !== before);
      return session;
    } catch (err) {
      this.noteUpgradeResult(nodeId, false);
      throw err;
    } finally {
      this.releaseUpgradeSlot();
    }
  }

  private hasWsSecureCandidate(nodeId: string): boolean {
    if (this.linkFactory) return true;
    const cached = this.userStore.getPeer(nodeId);
    return cached ? parseEndpoints(cached.endpointsJson, this.server?.port).length > 0 : false;
  }

  private dcCapable(nodeId: string): boolean {
    return this.rtc?.available === true && this.userStore.getPeer(nodeId)?.directCapable !== false;
  }

  private shouldTryDc(nodeId: string): boolean {
    return this.dcCapable(nodeId) && this.dcBreaker.shouldTry(nodeId).allow;
  }

  private handleIncomingRtcWake(fromNodeId: string, msg: RtcSignalMessage): void {
    if (this.stopped) return;
    const now = this.scheduler.now();
    const gate = this.ensureIncomingWakeGate(fromNodeId);
    const drop = (tag: string, dropped: string) =>
      rtcLogRateLimited(`wake:${tag}:${fromNodeId}`, 'signal recv', {
        peer: fromNodeId,
        kind: 'wake',
        dropped,
      });
    if (now < gate.nextEligibleAt) {
      drop('rate', 'rate');
      return;
    }
    if (!this.consumeWakeVerifyToken(gate, now)) {
      drop('rate', 'rate');
      return;
    }
    const wake = parseRtcWakeSdp(msg.sdp);
    if (!wake || !this.acceptSignedRtcWake(fromNodeId, msg, wake)) {
      drop('auth', 'auth');
      return;
    }
    gate.nextEligibleAt = now + PEER_RTC_WAKE_COOLDOWN_MS;
    if (this.identity.nodeId.toLowerCase() >= fromNodeId.toLowerCase()) {
      drop('role', 'not-offerer');
      return;
    }
    rtcLog('signal recv', { peer: fromNodeId, kind: 'wake' });
    const live = this.live.get(fromNodeId);
    if (live?.transport === 'dc' || !this.shouldTryDc(fromNodeId)) return;
    if (this.pending.has(fromNodeId) || this.upgrading.has(fromNodeId)) return;
    if (live && !this.wantsUpgrade(live)) return;
    void this.getLink(fromNodeId).catch(() => undefined);
  }

  private acceptSignedRtcWake(
    fromNodeId: string,
    msg: RtcSignalMessage,
    wake: RtcWakeFields
  ): boolean {
    if (wake.domain !== RTC_WAKE_DOMAIN) return false;
    if (wake.from.toLowerCase() !== fromNodeId.toLowerCase()) return false;
    if (wake.to.toLowerCase() !== this.identity.nodeId.toLowerCase()) return false;
    const session = peerRtcSession(wake.from, wake.to);
    if (wake.rtcSession.toLowerCase() !== session.toLowerCase()) return false;
    if (msg.rtcSession && msg.rtcSession.toLowerCase() !== session.toLowerCase()) return false;
    if (Math.abs(this.scheduler.now() - wake.issued_at) > RTC_WAKE_MAX_SKEW_MS) return false;
    if (!this.isTrusted(wake.from)) return false;
    const cert = this.userStore.getCert(wake.from);
    if (!cert) return false;
    let edPk: Uint8Array;
    try {
      edPk = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      return false;
    }
    if (!isCanonicalRtcWakeNonce(wake.nonce)) return false;
    if (!verifyRtcWakeSignature(wake, edPk)) return false;
    return this.rememberRtcWakeNonce(fromNodeId, wake.nonce, wake.issued_at);
  }

  private rememberRtcWakeNonce(fromNodeId: string, nonce: string, issuedAt: number): boolean {
    const from = fromNodeId.toLowerCase();
    let peer = this.rtcWakeNonces.get(from);
    if (!peer) {
      peer = new Map();
      this.rtcWakeNonces.set(from, peer);
    }
    this.pruneRtcWakeNonces(peer);
    if (peer.has(nonce)) return false;
    if (peer.size >= PEER_RTC_WAKE_NONCE_CACHE) return false;
    peer.set(nonce, issuedAt + RTC_WAKE_MAX_SKEW_MS);
    return true;
  }

  private pruneRtcWakeNonces(peer: Map<string, number>): void {
    const now = this.scheduler.now();
    for (const [nonce, exp] of peer) {
      if (now > exp) peer.delete(nonce);
    }
  }

  private ensureIncomingWakeGate(fromNodeId: string): IncomingWakeGate {
    let gate = this.incomingWakeGate.get(fromNodeId);
    if (!gate) {
      gate = {
        nextEligibleAt: 0,
        verifyTokens: PEER_RTC_WAKE_VERIFY_BURST,
        verifyRefillAt: 0,
      };
      this.incomingWakeGate.set(fromNodeId, gate);
    }
    return gate;
  }

  private consumeWakeVerifyToken(gate: IncomingWakeGate, now: number): boolean {
    const interval = PEER_RTC_WAKE_VERIFY_WINDOW_MS / PEER_RTC_WAKE_VERIFY_BURST;
    if (!(interval > 0)) return false;
    if (gate.verifyRefillAt <= 0) {
      gate.verifyTokens = PEER_RTC_WAKE_VERIFY_BURST;
      gate.verifyRefillAt = now;
    } else if (now > gate.verifyRefillAt) {
      const add = Math.floor((now - gate.verifyRefillAt) / interval);
      if (add > 0) {
        gate.verifyTokens = Math.min(PEER_RTC_WAKE_VERIFY_BURST, gate.verifyTokens + add);
        gate.verifyRefillAt += add * interval;
      }
    }
    if (gate.verifyTokens < 1) return false;
    gate.verifyTokens -= 1;
    return true;
  }

  private cancelDcUpgradeRetry(nodeId: string): void {
    const rec = this.dcUpgradeRetry.get(nodeId);
    if (!rec) return;
    rec.abort?.abort();
    rec.abort = null;
    this.dcUpgradeRetry.delete(nodeId);
  }

  private nextDcAttemptId(): string {
    this.dcAttemptSeq += 1;
    return `dc:${this.dcAttemptSeq}`;
  }

  private cancelDcHealthTimer(nodeId: string): void {
    const abort = this.dcHealth.get(nodeId);
    if (!abort) return;
    this.dcHealth.delete(nodeId);
    abort.abort();
  }

  private armDcHealthTimer(nodeId: string, attemptId: string): void {
    this.cancelDcHealthTimer(nodeId);
    const abort = new AbortController();
    this.dcHealth.set(nodeId, abort);
    const establishedAt = this.scheduler.now();
    const handle = this.scheduler.interval(() => {
      handle.clear();
      if (this.dcHealth.get(nodeId) !== abort) return;
      this.dcHealth.delete(nodeId);
      if (this.scheduler.now() - establishedAt < RTC_DIAL_BREAKER_HEALTHY_MS) return;
      const live = this.live.get(nodeId);
      if (live?.transport !== 'dc' || live.dcAttemptId !== attemptId) return;
      if (this.dcBreaker.noteHealthy(nodeId)) this.emitLinkInfo(live);
    }, RTC_DIAL_BREAKER_HEALTHY_MS);
    abort.signal.addEventListener(
      'abort',
      () => {
        handle.clear();
        if (this.dcHealth.get(nodeId) === abort) this.dcHealth.delete(nodeId);
      },
      { once: true }
    );
  }

  private dcUpgradeRetryDelayMs(attempt: number): number {
    return attempt < PEER_DC_UPGRADE_RETRY_DELAYS_MS.length
      ? PEER_DC_UPGRADE_RETRY_DELAYS_MS[attempt]
      : PEER_DC_UPGRADE_RETRY_TAIL_MS;
  }

  private armDcUpgradeRetry(nodeId: string): void {
    if (this.stopped) return;
    if (!this.dcCapable(nodeId)) {
      this.lostDirect.delete(nodeId);
      this.cancelDcUpgradeRetry(nodeId);
      return;
    }
    const decision = this.dcBreaker.shouldTry(nodeId);
    if (!decision.allow) {
      this.scheduleDcBreakerProbe(nodeId, decision.until);
      return;
    }
    const live = this.live.get(nodeId);
    if (live?.transport === 'dc') {
      this.lostDirect.delete(nodeId);
      this.cancelDcUpgradeRetry(nodeId);
      return;
    }
    if (!live) return;
    if (!live.quiesceCapable) return;
    let rec = this.dcUpgradeRetry.get(nodeId);
    if (!rec) {
      rec = { attempt: 0, abort: null };
      this.dcUpgradeRetry.set(nodeId, rec);
    }
    if (rec.abort) return;
    const inMs = this.dcUpgradeRetryDelayMs(rec.attempt);
    const attempt = rec.attempt + 1;
    rtcLog('upgrade retry', { peer: nodeId, attempt, in_ms: inMs });
    const abort = new AbortController();
    rec.abort = abort;
    const onStop = () => abort.abort();
    this.stopAbort.signal.addEventListener('abort', onStop, { once: true });
    void this.scheduler.sleep(inMs, abort.signal).then(
      () => {
        this.stopAbort.signal.removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
        rec.attempt = attempt;
        if (this.stopped) return;
        if (this.live.get(nodeId)?.transport === 'dc') {
          this.lostDirect.delete(nodeId);
          this.cancelDcUpgradeRetry(nodeId);
          return;
        }
        if (!this.shouldTryDc(nodeId) || !this.live.get(nodeId)) return;
        this.maybeUpgrade(nodeId, { cooldown: true });
        const pending = this.upgrading.get(nodeId) ?? this.pending.get(nodeId);
        if (pending) {
          void pending
            .finally(() => {
              if (this.live.get(nodeId)?.transport === 'dc') {
                this.lostDirect.delete(nodeId);
                this.cancelDcUpgradeRetry(nodeId);
                return;
              }
              this.armDcUpgradeRetry(nodeId);
            })
            .catch(() => undefined);
        } else {
          this.armDcUpgradeRetry(nodeId);
        }
      },
      () => {
        this.stopAbort.signal.removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
      }
    );
  }

  private scheduleDcBreakerProbe(nodeId: string, until: number | null): void {
    const live = this.live.get(nodeId);
    if (live?.transport === 'dc') {
      this.lostDirect.delete(nodeId);
      this.cancelDcUpgradeRetry(nodeId);
      return;
    }
    if (!live || !live.quiesceCapable) return;
    let rec = this.dcUpgradeRetry.get(nodeId);
    if (!rec) {
      rec = { attempt: 0, abort: null };
      this.dcUpgradeRetry.set(nodeId, rec);
    }
    if (rec.abort) return;
    const inMs = Math.max(0, (until ?? this.scheduler.now()) - this.scheduler.now());
    rtcLog('upgrade retry', {
      peer: nodeId,
      attempt: rec.attempt + 1,
      in_ms: inMs,
      cause: 'breaker_cooling',
    });
    const abort = new AbortController();
    rec.abort = abort;
    const onStop = () => abort.abort();
    this.stopAbort.signal.addEventListener('abort', onStop, { once: true });
    void this.scheduler.sleep(inMs, abort.signal).then(
      () => {
        this.stopAbort.signal.removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
        if (this.stopped) return;
        if (this.live.get(nodeId)?.transport === 'dc') {
          this.lostDirect.delete(nodeId);
          this.cancelDcUpgradeRetry(nodeId);
          return;
        }
        if (!this.live.get(nodeId)) return;
        if (!this.shouldTryDc(nodeId)) {
          const next = this.dcBreaker.shouldTry(nodeId);
          if (next.cooling) this.scheduleDcBreakerProbe(nodeId, next.until);
          return;
        }
        this.maybeUpgrade(nodeId, { cooldown: true });
        const pending = this.upgrading.get(nodeId) ?? this.pending.get(nodeId);
        if (pending) {
          void pending
            .finally(() => {
              if (this.live.get(nodeId)?.transport === 'dc') {
                this.lostDirect.delete(nodeId);
                this.cancelDcUpgradeRetry(nodeId);
                return;
              }
              this.armDcUpgradeRetry(nodeId);
            })
            .catch(() => undefined);
        } else {
          this.armDcUpgradeRetry(nodeId);
        }
      },
      () => {
        this.stopAbort.signal.removeEventListener('abort', onStop);
        if (rec.abort === abort) rec.abort = null;
      }
    );
  }

  private ensureWakeGate(peerNodeId: string): WakeGate {
    let gate = this.wakeGate.get(peerNodeId);
    if (!gate) {
      gate = { inflight: false, nextEligibleAt: 0, deferredAbort: null };
      this.wakeGate.set(peerNodeId, gate);
    }
    return gate;
  }

  private abortDeferredRtcWakes(): void {
    for (const gate of this.wakeGate.values()) {
      this.disarmDeferredRtcWake(gate);
    }
  }

  private disarmDeferredRtcWake(gate: WakeGate): void {
    gate.deferredAbort?.abort();
    gate.deferredAbort = null;
  }

  private armDeferredRtcWake(peerNodeId: string, gate: WakeGate): void {
    if (gate.deferredAbort || this.stopped) return;
    const delay = Math.max(0, gate.nextEligibleAt - this.scheduler.now());
    const abort = new AbortController();
    gate.deferredAbort = abort;
    const onStop = () => abort.abort();
    this.stopAbort.signal.addEventListener('abort', onStop, { once: true });
    void this.scheduler.sleep(delay, abort.signal).then(
      () => {
        this.stopAbort.signal.removeEventListener('abort', onStop);
        if (gate.deferredAbort === abort) gate.deferredAbort = null;
        if (this.stopped) return;
        gate.nextEligibleAt = Math.min(gate.nextEligibleAt, this.scheduler.now());
        this.dispatchRtcWake(peerNodeId);
      },
      () => {
        this.stopAbort.signal.removeEventListener('abort', onStop);
        if (gate.deferredAbort === abort) gate.deferredAbort = null;
      }
    );
  }

  private releaseRtcWakeAttempt(peerNodeId: string): void {
    const gate = this.wakeGate.get(peerNodeId);
    if (!gate) return;
    gate.inflight = false;
    this.disarmDeferredRtcWake(gate);
  }

  private dispatchRtcWake(peerNodeId: string): void {
    if (this.identity.nodeId.toLowerCase() < peerNodeId.toLowerCase()) return;
    if (this.live.get(peerNodeId)?.transport === 'dc') {
      this.releaseRtcWakeAttempt(peerNodeId);
      return;
    }
    if (!this.shouldTryDc(peerNodeId)) return;
    const gate = this.ensureWakeGate(peerNodeId);
    if (gate.inflight) return;
    const now = this.scheduler.now();
    if (now < gate.nextEligibleAt) {
      this.armDeferredRtcWake(peerNodeId, gate);
      return;
    }
    gate.inflight = true;
    gate.nextEligibleAt = now + PEER_RTC_WAKE_COOLDOWN_MS;
    rtcLog('signal send', { peer: peerNodeId, kind: 'wake' });
    this.sendRtcSignal(peerNodeId, {
      rtcSession: peerRtcSession(this.identity.nodeId, peerNodeId),
      from: 'node',
      to: peerNodeId,
      sdp: encodeRtcWakeSdp({
        from: this.identity.nodeId,
        to: peerNodeId,
        rtcSession: peerRtcSession(this.identity.nodeId, peerNodeId),
        issuedAt: now,
        secretKey: this.identity.edSecretKey,
      }),
    });
  }

  private notifyTransport(nodeId: string): void {
    const current = this.transportOf(nodeId);
    const waiters = this.transportWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) return;
    const keep: TransportWaiter[] = [];
    for (const waiter of waiters) {
      if (current === waiter.kind) waiter.resolve(true);
      else keep.push(waiter);
    }
    if (keep.length > 0) this.transportWaiters.set(nodeId, keep);
    else this.transportWaiters.delete(nodeId);
  }

  private notifyLive(nodeId: string, session: LinkSession): void {
    const waiters = this.liveWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) return;
    this.liveWaiters.delete(nodeId);
    for (const waiter of waiters) waiter.resolve(session);
  }

  private waitForLive(nodeId: string): { promise: Promise<LinkSession>; cancel: () => void } {
    let waiter: LiveWaiter | undefined;
    const promise = new Promise<LinkSession>((resolve) => {
      waiter = { resolve };
      const list = this.liveWaiters.get(nodeId) ?? [];
      list.push(waiter);
      this.liveWaiters.set(nodeId, list);
    });
    return {
      promise,
      cancel: () => {
        if (!waiter) return;
        const list = this.liveWaiters.get(nodeId);
        if (!list) return;
        const next = list.filter((row) => row !== waiter);
        if (next.length > 0) this.liveWaiters.set(nodeId, next);
        else this.liveWaiters.delete(nodeId);
      },
    };
  }

  private async awaitEstablishedOrDial(
    nodeId: string,
    dial: Promise<LinkSession>
  ): Promise<LinkSession> {
    const current = this.live.get(nodeId);
    if (current) return current.session;
    const liveWait = this.waitForLive(nodeId);
    try {
      const winner = await Promise.race([
        dial.then(
          (session) => ({ ok: true as const, session }),
          (err: unknown) => ({ ok: false as const, err })
        ),
        liveWait.promise.then((session) => ({ ok: true as const, session })),
      ]);
      const live = this.live.get(nodeId);
      if (live) {
        this.maybeUpgrade(nodeId, { cooldown: true, userPath: true });
        return live.session;
      }
      if (!winner.ok) throw winner.err;
      return winner.session;
    } finally {
      liveWait.cancel();
    }
  }

  private failTransportWaiters(nodeId: string): void {
    const waiters = this.transportWaiters.get(nodeId);
    if (!waiters || waiters.length === 0) return;
    this.transportWaiters.delete(nodeId);
    for (const waiter of waiters) waiter.resolve(false);
  }

  private signalingFor(peerNodeId: string): RtcSignaling {
    return {
      send: (msg) => this.sendRtcSignal(peerNodeId, msg),
      onMessage: (cb) => {
        let set = this.rtcListeners.get(peerNodeId);
        if (!set) {
          set = new Set();
          this.rtcListeners.set(peerNodeId, set);
        }
        set.add(cb);
        const inbox = this.rtcInbox.get(peerNodeId);
        if (inbox && inbox.length > 0) {
          this.rtcInbox.delete(peerNodeId);
          for (const msg of inbox) cb(msg);
        }
        return () => {
          set?.delete(cb);
          if (set && set.size === 0) this.rtcListeners.delete(peerNodeId);
        };
      },
    };
  }

  private sendRtcSignal(peerNodeId: string, msg: RtcSignalMessage): void {
    const payload = {
      t: 'rtc.signal' as const,
      rtcSession: msg.rtcSession,
      from: msg.from,
      to: msg.to,
      ...(msg.sdp ? { sdp: msg.sdp } : {}),
      ...(msg.candidate ? { candidate: msg.candidate } : {}),
    };
    const live = this.live.get(peerNodeId);
    if (live && live.transport !== 'dc') {
      this.sendPeerCtl(live, payload);
      return;
    }
    this.ensureDcSession?.(peerNodeId, msg.rtcSession);
    try {
      this.uplink.sendCtl(payload);
    } catch {
      // uplink offline
    }
  }

  private releaseRtcAttempt(peerNodeId: string, unsub: (() => void) | null): void {
    unsub?.();
    this.rtcInbox.delete(peerNodeId);
  }

  private async dialDc(
    nodeId: string,
    gen: number,
    signal: AbortSignal
  ): Promise<LinkSession | null> {
    if (!this.rtc) return null;
    const attemptId = this.nextDcAttemptId();
    this.dcBreaker.beginAttempt(nodeId, attemptId);
    const signaling = this.signalingFor(nodeId);
    let unsub: (() => void) | null = null;
    const wrapped: RtcSignaling = {
      send: (msg) => signaling.send(msg),
      onMessage: (cb) => {
        unsub = signaling.onMessage(cb);
        return unsub;
      },
    };
    const connectP = this.rtc.connectToPeer(nodeId, wrapped);
    this.dispatchRtcWake(nodeId);
    try {
      const result = await abortable(connectP, signal);
      if (this.stale(gen)) {
        this.releaseRtcAttempt(nodeId, unsub);
        unsub = null;
        quiet(() => result.pc.close());
        throw new Error('stopped');
      }
      const session = new LinkMux(result.link, {
        role: result.role,
        logContext: { nodeId: result.peerNodeId, transport: 'dc' },
      });
      const initiatedBy = result.role === 'initiator' ? this.identity.nodeId : result.peerNodeId;
      const pair = result.pc.getSelectedCandidatePair?.();
      const remoteAddress =
        pair?.remote?.address ?? addressFromIceCandidate(pair?.remote?.candidate) ?? null;
      const kept = this.track(
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
        const live = this.live.get(result.peerNodeId);
        if (live) live.unsubRtc = unsub;
        unsub = null;
        return kept;
      }
      this.releaseRtcAttempt(nodeId, unsub);
      unsub = null;
      return kept;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = (err instanceof Error && err.name === 'AbortError') || /abort/i.test(message);
      if (!this.stopped && !aborted && !isIntentionalDcLoss(message)) {
        this.dcBreaker.noteFailure(nodeId, classifyRtcDialFailure(message), attemptId);
      }
      this.releaseRtcAttempt(nodeId, unsub);
      throw err;
    } finally {
      this.releaseRtcWakeAttempt(nodeId);
    }
  }

  private async dial(nodeId: string): Promise<LinkSession> {
    await Promise.resolve();
    const gen = this.generation;
    const signal = this.stopAbort.signal;
    const existingLive = this.live.get(nodeId);
    const floor = existingLive ? PEER_TRANSPORT_RANK[existingLive.transport] : 0;
    const skipDcFirst = !existingLive && this.lostDirect.has(nodeId);
    let dcError: unknown = null;
    const attempt = emptyDirectAttempt(this.scheduler.now());
    const above = (kind: PeerTransportKind) => PEER_TRANSPORT_RANK[kind] > floor;
    const tryDc = async (): Promise<LinkSession | null> => {
      if (!above('dc') || !this.dcCapable(nodeId)) return null;
      const decision = this.dcBreaker.shouldTry(nodeId);
      if (!decision.allow) {
        rtcLog('dial failed', {
          peer: nodeId,
          cause: 'breaker_cooling',
          until: decision.until,
        });
        return null;
      }
      try {
        return await this.dialDc(nodeId, gen, signal);
      } catch (err) {
        dcError = err;
        rtcLog('dial failed', {
          peer: nodeId,
          reason: err instanceof Error ? err.message : String(err),
        });
        this.throwIfStopped(nodeId, gen, err);
        return null;
      }
    };
    const liveOf = async () => this.live.get(nodeId)?.session ?? null;
    const attempts: Array<{
      run: () => Promise<LinkSession | null>;
      skipStop?: boolean;
    }> = [];
    if (!skipDcFirst) attempts.push({ run: tryDc });
    if (above('ws-secure')) {
      attempts.push({
        run: () => this.dialWsSecure(nodeId, gen, signal, attempt),
      });
    }
    attempts.push({ run: liveOf });
    if (skipDcFirst) {
      attempts.push({ run: tryDc, skipStop: true });
      attempts.push({ run: liveOf });
    }
    for (const step of attempts) {
      const got = await step.run();
      if (got) {
        this.finishDirectAttempt(nodeId, attempt, got, dcError);
        return got;
      }
      if (!step.skipStop) this.throwIfStopped(nodeId, gen);
    }
    this.finishDirectAttempt(nodeId, attempt, null, dcError);
    try {
      const stream = await this.uplink.openRelay(nodeId);
      const result = await handshakeRelay({
        stream,
        role: 'initiator',
        identity: this.identity,
        userStore: this.userStore,
      });
      if (result.peerNodeId !== nodeId) {
        result.session.close('peer-id-mismatch');
        throw new NodeUnreachableError(nodeId, 'relay peer id mismatch');
      }
      this.rememberKeys(result.session, result.sendKey, result.recvKey);
      const kept = this.track(
        result.session,
        result.peerNodeId,
        'relay',
        this.identity.nodeId,
        gen
      );
      if (!kept) throw new NodeUnreachableError(nodeId, 'simultaneous-dial');
      return kept;
    } catch (err) {
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
  }

  private lanDialBudgetMs(url: string): number | undefined {
    return classifyRemoteAddress(hostFromWsUrl(url)) === 'lan'
      ? PEER_LAN_DIAL_TIMEOUT_MS
      : undefined;
  }

  private syncLocalFingerprint(): void {
    const next = localNetworkFingerprint(this.interfacesFn());
    if (this.localFingerprint && next !== this.localFingerprint) {
      this.endpointBackoff.resetAll();
    }
    this.localFingerprint = next;
  }

  private syncPeerEndpointSet(nodeId: string): void {
    const cached = this.userStore.getPeer(nodeId);
    const urls = cached ? parseEndpoints(cached.endpointsJson, this.server?.port) : [];
    const next = canonicalEndpointSet(urls);
    const prev = this.advertisedEndpointSet.get(nodeId);
    if (prev !== undefined && prev !== next) this.endpointBackoff.resetNode(nodeId);
    this.advertisedEndpointSet.set(nodeId, next);
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
          if (this.stale(gen)) {
            quiet(() => session.close('stopped'));
            throw new NodeUnreachableError(nodeId, 'peer manager stopped');
          }
          const kept = this.track(
            session,
            nodeId,
            'ws-secure',
            this.identity.nodeId,
            gen,
            false,
            null
          );
          if (kept) return kept;
        }
      } catch (err) {
        this.throwIfStopped(nodeId, gen, err);
      }
    }
    const cached = this.userStore.getPeer(nodeId);
    const parsed =
      opts?.endpoints ?? (cached ? parseEndpoints(cached.endpointsJson, this.server?.port) : []);
    const endpoints = rankPeerEndpoints(parsed, this.interfacesFn());
    if (endpoints.length === 0) return null;
    const now = this.scheduler.now();
    const eligible = opts?.bypassBackoff
      ? endpoints
      : endpoints.filter((url) => this.endpointBackoff.eligible(nodeId, url, now));
    if (eligible.length === 0) {
      const waitMs = this.endpointBackoff.minWaitMs(nodeId, endpoints, now);
      const secs = Math.max(0, Math.ceil(waitMs / 1000));
      noteWsOutcome(attempt, `all endpoints backing off (next eligible in ${secs}s)`, endpoints);
      return null;
    }
    const raced = await raceWsSecureEndpoints({
      urls: eligible,
      gen,
      signal,
      stale: (g) => this.stale(g),
      sleep: (ms, sig) => this.scheduler.sleep(ms, sig),
      staggerMs: PEER_WS_DIAL_STAGGER_MS,
      dial: async (url, combined) => {
        try {
          const candidate = await dialWsSecureCandidate({
            url,
            expectedId: nodeId,
            gen,
            signal: combined,
            stale: (g) => this.stale(g),
            connectTimeoutMs: this.connectTimeoutMs,
            totalTimeoutMs: this.lanDialBudgetMs(url),
            factory: this.wsFactory,
            identity: this.identity,
            userStore: this.userStore,
            limiter: this.dialLimiter,
          });
          if (candidate) this.endpointBackoff.noteSuccess(nodeId, url);
          return candidate;
        } catch (err) {
          const classified = classifyWsDialFailure(url, err);
          this.endpointBackoff.noteFailure(nodeId, url, classified.kind);
          throw classified;
        }
      },
    });
    if (raced.lastReason) noteWsOutcome(attempt, raced.lastReason, endpoints);
    if (this.stale(gen)) {
      quiet(() => raced.winner?.session.close('stopped'));
      this.throwIfStopped(nodeId, gen);
    }
    const winner = raced.winner;
    if (!winner) return null;
    this.rememberKeys(winner.session, winner.sendKey, winner.recvKey);
    return this.track(
      winner.session,
      winner.peerNodeId,
      'ws-secure',
      this.identity.nodeId,
      gen,
      false,
      hostFromWsUrl(winner.url)
    );
  }

  private async acceptDirect(
    socket: ServerSocketAdapter,
    remoteAddress: string | null
  ): Promise<void> {
    const gen = this.generation;
    try {
      const result = await handshakeWsDirect({
        socket,
        role: 'acceptor',
        identity: this.identity,
        userStore: this.userStore,
      });
      if (this.stale(gen)) {
        quiet(() => result.session.close('stopped'));
        return;
      }
      this.rememberKeys(result.session, result.sendKey, result.recvKey);
      this.track(
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

  private async acceptRelay(stream: LinkStream, from: string): Promise<void> {
    const gen = this.generation;
    try {
      const result = await handshakeRelay({
        stream,
        role: 'acceptor',
        identity: this.identity,
        userStore: this.userStore,
      });
      if (this.stale(gen)) {
        quiet(() => result.session.close('stopped'));
        return;
      }
      this.rememberKeys(result.session, result.sendKey, result.recvKey);
      this.track(result.session, result.peerNodeId, 'relay', from || result.peerNodeId, gen);
    } catch {
      quiet(() => stream.reset('handshake-failed'));
    }
  }

  private track(
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable = false,
    remoteAddress: string | null = null,
    dcAttemptId: string | null = null
  ): LinkSession | null {
    const reject = (reason: string, keep: LinkSession | null = null) => {
      quiet(() => session.close(reason));
      return keep;
    };
    if (this.stale(gen)) return reject('stale');
    if (!this.isTrusted(peerNodeId)) return reject('not-trusted');
    const prev = this.live.get(peerNodeId);
    const resolvedAddress =
      remoteAddress ?? (transport === 'dc' ? (prev?.remoteAddress ?? null) : null);
    if (prev && prev.session !== session) {
      const rank = comparePeerTransport(transport, prev.transport);
      if (rank < 0) return reject('lower-priority', prev.session);
      if (rank === 0) {
        const winner = winningDialInitiator(this.identity.nodeId, peerNodeId);
        if (initiatedBy !== winner && prev.initiatedBy === winner) {
          return reject('simultaneous-dial', prev.session);
        }
      }
      if (!prev.quiesceCapable) {
        this.parkInbound(peerNodeId, session, transport, initiatedBy, gen, resolvedAddress);
        this.probeQuiesce(prev);
        return prev.session;
      }
      this.retirePeer(prev, 'replaced');
    }
    return this.installLive(
      session,
      peerNodeId,
      transport,
      initiatedBy,
      gen,
      quiesceCapable,
      resolvedAddress,
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
    dcAttemptId: string | null = null
  ): LinkSession {
    const keys = this.sessionKeys.get(session);
    const live: LivePeer = {
      session,
      peerNodeId,
      transport,
      initiatedBy,
      generation: gen,
      streams: 0,
      lastStreamAt: this.scheduler.now(),
      idleTimer: null,
      pingTimer: null,
      missedPongs: 0,
      retiring: false,
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
      lastRttEmitAt: 0,
      lastEmittedRttMs: null,
      linkSinceAt: this.scheduler.now(),
      dcAttemptId: transport === 'dc' ? (dcAttemptId ?? this.nextDcAttemptId()) : null,
    };
    this.live.set(peerNodeId, live);
    if (transport === 'dc') {
      this.dcBreaker.noteChannelEstablished(peerNodeId, live.dcAttemptId ?? undefined);
      flushDialFailed(peerNodeId, { cause: 'established' });
      if (live.dcAttemptId) this.armDcHealthTimer(peerNodeId, live.dcAttemptId);
    }
    if (transport === 'dc' || transport === 'ws-secure') {
      this.clearDirectFailure(peerNodeId);
    }
    this.bindSession(live);
    if (!live.quiesceCapable) this.sendLinkHello(live);
    this.armIdle(live);
    this.startPing(live);
    this.sendPeerStatus(live);
    this.notifyTransport(peerNodeId);
    this.notifyLive(peerNodeId, session);
    this.emitLinkInfo(live);
    if (transport === 'dc') {
      this.lostDirect.delete(peerNodeId);
      this.cancelDcUpgradeRetry(peerNodeId);
    } else if (this.lostDirect.has(peerNodeId) && live.quiesceCapable) {
      this.armDcUpgradeRetry(peerNodeId);
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
      const retiringSet = this.retiring.get(peerNodeId);
      const isCurrent = this.live.get(peerNodeId) === live;
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
      this.handleInboundStream(peerNodeId, stream);
    });
    session.ctl.onMessage((bytes) => {
      this.handlePeerCtl(live, bytes);
    });
    void session.closed.then((info) => {
      const reason = info?.reason ?? 'closed';
      if (this.live.get(peerNodeId)?.session === session) {
        this.dropPeer(peerNodeId, reason);
      }
      const set = this.retiring.get(peerNodeId);
      if (set) {
        for (const row of [...set]) {
          if (row.session === session) this.finishRetire(row, reason);
        }
      }
    });
  }

  private onLocalStream(live: LivePeer, stream: LinkStream): void {
    live.streams += 1;
    live.lastStreamAt = this.scheduler.now();
    live.zeroStreamsSince = 0;
    this.clearIdle(live);
    if (live.retiring) this.armRetireTimer(live);
    void stream.closed.then(() => {
      live.streams = Math.max(0, live.streams - 1);
      live.lastStreamAt = this.scheduler.now();
      if (live.streams === 0) live.zeroStreamsSince = this.scheduler.now();
      if (live.streams > 0) return;
      if (live.retiring) {
        this.maybeFinishRetire(live);
        if (live.retiring && !live.finishRetired) this.armRetireTimer(live);
        return;
      }
      if (this.live.get(live.peerNodeId) === live) this.armIdle(live);
    });
  }

  private handleInboundStream(peerNodeId: string, stream: LinkStream): void {
    const kind = classifyOpenPayload(stream.openPayload);
    if (kind === 'http') {
      if (!this.dispatchHttp || !this.sessionStore) {
        stream.reset('http-not-configured');
        return;
      }
      void acceptHttpStream(stream, {
        peerNodeId,
        sessionStore: this.sessionStore,
        dispatchHttp: this.dispatchHttp,
        now: () => this.scheduler.now(),
      });
      return;
    }
    if (kind === 'ws') {
      if (!this.wsServer || !this.sessionStore) {
        stream.reset('ws-not-configured');
        return;
      }
      void acceptWsStream(stream, {
        peerNodeId,
        sessionStore: this.sessionStore,
        wsServer: this.wsServer,
        now: () => this.scheduler.now(),
        onGatewaySession: this.onGatewaySession ?? undefined,
        onGatewaySessionClose: this.onGatewaySessionClose ?? undefined,
      });
    }
  }

  private handlePeerCtl(live: LivePeer, bytes: Uint8Array): void {
    const msg = parseOpenPayload(bytes);
    if (!msg || typeof msg.t !== 'string') return;
    const t = msg.t;
    const asyncCtl = {
      'node.status': () => this.applyPeerStatus(live, msg),
      'key.log.req': () => this.serveKeyLog(live, msg),
      'key.log.res': () => this.applyKeyLogRes(msg),
    } as const;
    const work = asyncCtl[t as keyof typeof asyncCtl];
    if (work) this.runCtlAsync(t, live.peerNodeId, work);
    else if (t === 'ping') this.sendPeerCtl(live, { t: 'pong' });
    else if (t === 'pong') this.onPeerPong(live);
    else if (t === 'link.hello') {
      if ((Array.isArray(msg.caps) ? msg.caps : []).includes('quiesce')) {
        this.markQuiesceCapable(live);
      }
      if (!live.helloReplied) {
        live.helloReplied = true;
        this.sendLinkHello(live);
      }
    } else if (t === 'link.quiesce.probe') {
      this.markQuiesceCapable(live);
      this.sendPeerCtl(live, { t: 'link.quiesce.probe.ack' });
    } else if (t === 'link.quiesce.probe.ack') this.markQuiesceCapable(live);
    else if (t === 'link.quiesce' || t === 'link.quiesce.ack') {
      if (t === 'link.quiesce') {
        live.gotPeerQuiesce = true;
        this.sendPeerCtl(live, { t: 'link.quiesce.ack' });
      } else live.gotQuiesceAck = true;
      this.markQuiesceCapable(live);
      if (live.retiring) this.maybeFinishRetire(live);
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

  private async applyPeerStatus(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    if (!this.isTrusted(live.peerNodeId)) return;
    const peerNodeId = live.peerNodeId;
    const existing = this.userStore.getPeer(peerNodeId);
    const endpointsJson = jsonText(
      sanitizeEndpoints(msg.endpoints ?? existing?.endpointsJson ?? [], this.server?.port)
    );
    const inventoryJson = jsonText(msg.inventory ?? existing?.inventoryJson ?? {});
    const directCapable =
      typeof msg.direct_capable === 'boolean'
        ? msg.direct_capable
        : (existing?.directCapable ?? false);
    const lastSeenAt = this.scheduler.now();
    const changed =
      !existing ||
      existing.endpointsJson !== endpointsJson ||
      existing.inventoryJson !== inventoryJson ||
      existing.directCapable !== directCapable;
    if (changed) {
      this.userStore.upsertPeer({
        nodeId: peerNodeId,
        name: existing?.name ?? peerNodeId,
        endpointsJson,
        inventoryJson,
        directCapable,
        lastSeenAt,
        listVersion: existing?.listVersion ?? 0,
      });
      this.notifyPeerEndpointsChanged(peerNodeId);
    } else {
      this.userStore.touchPeerLastSeenAt(peerNodeId, lastSeenAt);
    }
    const head = isRecord(msg.key_log_head) ? msg.key_log_head : null;
    if (!head || !this.keyLogApplier) return;
    try {
      const remoteSeq = parseSeq(head.seq, 'key_log_head.seq');
      const local = await this.keyLogApplier.head(this.uplink.userId);
      if (remoteSeq > local.seq) {
        this.sendPeerCtl(live, { t: 'key.log.req', from_seq: Number(local.seq + 1n) });
      }
    } catch {
      // ignore
    }
  }

  private async serveKeyLog(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    if (!this.keyLogApplier?.list) return;
    const fromSeq = parseSeq(msg.from_seq, 'from_seq');
    const requested = typeof msg.limit === 'number' ? msg.limit : 256;
    const limit = Math.min(256, Math.max(1, requested));
    const fetched = await this.keyLogApplier.list(
      this.uplink.userId,
      fromSeq,
      undefined,
      limit + 1
    );
    const hasMore = fetched.length > limit;
    const records = hasMore ? fetched.slice(0, limit) : fetched;
    this.sendPeerCtl(live, {
      t: 'key.log.res',
      records: records.map((row) => ({
        seq: Number(row.seq),
        bytes: encodeBase64url(row.bytes),
        sig: encodeBase64url(row.sig),
      })),
      has_more: hasMore,
    });
  }

  private async applyKeyLogRes(msg: Record<string, unknown>): Promise<void> {
    if (!this.keyLogApplier || !Array.isArray(msg.records)) return;
    const records: { bytes: Uint8Array; sig: Uint8Array }[] = [];
    for (const row of msg.records) {
      if (!isRecord(row) || typeof row.bytes !== 'string' || typeof row.sig !== 'string') continue;
      records.push({ bytes: decodeBase64url(row.bytes), sig: decodeBase64url(row.sig) });
    }
    if (records.length > 0) {
      await this.keyLogApplier.applyMany(this.uplink.userId, records);
    }
  }

  private sendPeerStatus(live: LivePeer): void {
    const status = this.statusProvider?.();
    if (!status) return;
    const push = (head?: { seq: bigint; hash: Uint8Array }) => {
      const encoded = `${jsonStable(status)}\0${head ? `${head.seq.toString()}:${encodeBase64url(head.hash)}` : ''}`;
      if (encoded === live.lastAdvertisedStatusJson) return;
      live.lastAdvertisedStatusJson = encoded;
      this.sendPeerCtl(live, {
        t: 'node.status',
        version: status.version,
        tmux: status.tmux,
        direct_capable: status.direct_capable,
        inventory: status.inventory,
        endpoints: status.endpoints,
        name: status.name,
        ...(head
          ? { key_log_head: { seq: Number(head.seq), hash: encodeBase64url(head.hash) } }
          : {}),
      });
    };
    if (!this.keyLogApplier) {
      push();
      return;
    }
    void this.keyLogApplier
      .head(this.uplink.userId)
      .then((head) => {
        if (this.live.get(live.peerNodeId) !== live && !live.retiring) return;
        push(head);
      })
      .catch(() => undefined);
  }

  private startPing(live: LivePeer): void {
    live.pingTimer?.clear();
    live.missedPongs = 0;
    live.pingTimer = this.scheduler.interval(() => {
      if (this.live.get(live.peerNodeId) !== live) return;
      if (live.missedPongs >= PEER_MISSED_PONG_LIMIT) {
        this.dropPeer(live.peerNodeId, 'missed-pong');
        return;
      }
      live.missedPongs += 1;
      live.pingSentAt = performance.now();
      this.sendPeerCtl(live, { t: 'ping' });
    }, PEER_PING_INTERVAL_MS);
  }

  private onPeerPong(live: LivePeer): void {
    live.missedPongs = 0;
    if (live.pingSentAt == null) return;
    live.rttMs = Math.max(0, Math.round(performance.now() - live.pingSentAt));
    live.pingSentAt = null;
    this.maybeEmitRtt(live);
  }

  private emitLinkInfo(live: LivePeer): void {
    if (this.linkInfoHold > 0) return;
    this.onLinkInfo?.({
      nodeId: live.peerNodeId,
      reach: classifyPeerReach(live.transport, live.remoteAddress),
      transport: live.transport,
      rttMs: live.rttMs,
      dcBreaker: this.dcBreaker.snapshot(live.peerNodeId),
    });
  }

  private emitOfflineLinkInfo(nodeId: string): void {
    if (this.linkInfoHold > 0) return;
    this.onLinkInfo?.({
      nodeId,
      reach: null,
      transport: null,
      rttMs: null,
      dcBreaker: this.dcBreaker.snapshot(nodeId),
    });
  }

  private maybeEmitRtt(live: LivePeer): void {
    if (!rttChangedMaterially(live.lastEmittedRttMs, live.rttMs)) return;
    const now = this.scheduler.now();
    if (live.lastEmittedRttMs != null && now - live.lastRttEmitAt < RTT_EVENT_MIN_INTERVAL_MS) {
      return;
    }
    live.lastRttEmitAt = now;
    live.lastEmittedRttMs = live.rttMs;
    this.emitLinkInfo(live);
  }

  private armIdle(live: LivePeer): void {
    this.clearIdle(live);
    if (this.live.get(live.peerNodeId) !== live) return;
    if (live.streams > 0) return;
    const startedAt = this.scheduler.now();
    live.idleTimer = this.scheduler.interval(
      () => {
        if (this.live.get(live.peerNodeId) !== live) return;
        if (live.streams > 0) return;
        if (
          this.scheduler.now() - live.lastStreamAt >= this.idleMs &&
          this.scheduler.now() - startedAt >= this.idleMs
        ) {
          this.dropPeer(live.peerNodeId, 'idle');
        }
      },
      Math.max(1, this.idleMs)
    );
  }

  private clearIdle(live: LivePeer): void {
    live.idleTimer?.clear();
    live.idleTimer = null;
  }

  private dropPeer(nodeId: string, reason: string): void {
    const live = this.live.get(nodeId);
    const wasDc = live?.transport === 'dc';
    const dcAttemptId = live?.dcAttemptId ?? null;
    if (wasDc) this.cancelDcHealthTimer(nodeId);
    if (live) {
      this.live.delete(nodeId);
      this.finishRetire(live, reason);
    }
    const incoming = this.ensureIncomingWakeGate(nodeId);
    incoming.nextEligibleAt = Math.max(
      incoming.nextEligibleAt,
      this.scheduler.now() + PEER_RTC_WAKE_COOLDOWN_MS
    );
    this.notifyTransport(nodeId);
    if (this.stopped || reason === 'revoked') {
      this.cancelDcUpgradeRetry(nodeId);
      this.lostDirect.delete(nodeId);
      if (reason === 'revoked') this.dcBreaker.reset(nodeId);
      this.dropParked(nodeId, reason);
      this.emitOfflineLinkInfo(nodeId);
      return;
    }
    if (wasDc && !isIntentionalDcLoss(reason)) {
      this.dcBreaker.noteFailure(nodeId, classifyRtcDialFailure(reason), dcAttemptId ?? undefined);
    }
    if (wasDc) {
      this.lostDirect.add(nodeId);
      const gate = this.ensureGate(nodeId);
      gate.failures = 0;
      gate.nextEligibleAt = 0;
      gate.coalesced = false;
    }
    // 提升完成后再发一次 link info，避免中间态 reach=null 被当成离线
    this.linkInfoHold += 1;
    try {
      this.promoteRetiring(nodeId);
      this.activateParked(nodeId);
    } finally {
      this.linkInfoHold -= 1;
    }
    if (wasDc) this.armDcUpgradeRetry(nodeId);
    const next = this.live.get(nodeId);
    if (next) this.emitLinkInfo(next);
    else this.emitOfflineLinkInfo(nodeId);
  }

  private promoteRetiring(nodeId: string): boolean {
    if (this.live.get(nodeId)) return false;
    const set = this.retiring.get(nodeId);
    if (!set || set.size === 0) return false;
    let best: LivePeer | null = null;
    for (const row of set) {
      if (row.finishRetired) continue;
      if (!best || comparePeerTransport(row.transport, best.transport) > 0) best = row;
    }
    if (!best) return false;
    set.delete(best);
    if (set.size === 0) this.retiring.delete(nodeId);
    best.retiring = false;
    best.retiredAt = 0;
    best.retireTimer?.clear();
    best.retireTimer = null;
    best.gotQuiesceAck = false;
    best.gotPeerQuiesce = false;
    best.rttMs = null;
    best.pingSentAt = null;
    best.lastEmittedRttMs = null;
    best.lastRttEmitAt = 0;
    this.live.set(nodeId, best);
    this.armIdle(best);
    this.startPing(best);
    this.sendPeerStatus(best);
    this.notifyTransport(nodeId);
    this.notifyLive(nodeId, best.session);
    this.emitLinkInfo(best);
    return true;
  }

  private parkInbound(
    peerNodeId: string,
    session: LinkSession,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    remoteAddress: string | null
  ): void {
    const existing = this.parked.get(peerNodeId);
    const parkedAt = existing?.at ?? this.scheduler.now();
    if (existing) {
      this.parked.delete(peerNodeId);
      existing.timer?.clear();
      this.parkedSessions.delete(existing.session);
      quiet(() => existing.session.close('replaced-park'));
    }
    this.armParkedDrain(session);
    this.parkedSessions.add(session);
    const parked: ParkedInbound = {
      session,
      transport,
      initiatedBy,
      generation: gen,
      at: parkedAt,
      timer: null,
      remoteAddress,
    };
    parked.timer = this.scheduler.interval(
      () => {
        if (this.parked.get(peerNodeId) !== parked) return;
        if (this.scheduler.now() - parked.at >= PEER_RETIRE_MAX_MS) {
          this.dropParked(peerNodeId, 'park-timeout');
        }
      },
      Math.max(1, PEER_RETIRE_MAX_MS - (this.scheduler.now() - parkedAt))
    );
    void session.closed.then(() => {
      const cur = this.parked.get(peerNodeId);
      if (cur?.session === session) {
        cur.timer?.clear();
        this.parkedSessions.delete(session);
        this.parked.delete(peerNodeId);
      }
    });
    this.parked.set(peerNodeId, parked);
  }

  private armParkedDrain(session: LinkSession): void {
    session.onStream((stream) => {
      if (!this.parkedSessions.has(session)) return;
      quiet(() => stream.reset('parked'));
    });
    session.ctl.onMessage(() => {
      // drain ctl while parked so the inbox cannot grow
    });
  }

  private dropParked(nodeId: string, reason: string): void {
    const parked = this.parked.get(nodeId);
    if (!parked) return;
    this.parked.delete(nodeId);
    parked.timer?.clear();
    this.parkedSessions.delete(parked.session);
    quiet(() => parked.session.close(reason));
  }

  private activateParked(nodeId: string): void {
    const parked = this.parked.get(nodeId);
    if (!parked) return;
    if (!this.isTrusted(nodeId)) {
      this.dropParked(nodeId, 'not-trusted');
      return;
    }
    this.parked.delete(nodeId);
    parked.timer?.clear();
    this.parkedSessions.delete(parked.session);
    this.track(
      parked.session,
      nodeId,
      parked.transport,
      parked.initiatedBy,
      parked.generation,
      false,
      parked.remoteAddress
    );
  }

  private retirePeer(prev: LivePeer, reason: string): void {
    if (this.live.get(prev.peerNodeId) === prev) {
      this.live.delete(prev.peerNodeId);
    }
    this.clearIdle(prev);
    prev.pingTimer?.clear();
    prev.pingTimer = null;
    if (prev.finishRetired) {
      this.finishRetire(prev, reason);
      return;
    }
    prev.retiring = true;
    prev.retiredAt = this.scheduler.now();
    prev.zeroStreamsSince = prev.streams === 0 ? prev.retiredAt : 0;
    prev.gotQuiesceAck = false;
    prev.gotPeerQuiesce = false;
    let set = this.retiring.get(prev.peerNodeId);
    if (!set) {
      set = new Set();
      this.retiring.set(prev.peerNodeId, set);
    }
    set.add(prev);
    this.sendPeerCtl(prev, { t: 'link.quiesce' });
    this.armRetireTimer(prev, reason);
    this.maybeFinishRetire(prev, reason);
  }

  private nextRetireDelayMs(live: LivePeer): number {
    const now = this.scheduler.now();
    let due = live.retiredAt + PEER_RETIRE_MAX_MS;
    if (live.streams === 0 && live.zeroStreamsSince > 0) {
      due = Math.min(
        due,
        Math.max(live.retiredAt + PEER_RETIRE_MIN_MS, live.zeroStreamsSince + PEER_RETIRE_QUIET_MS)
      );
    }
    return Math.max(1, due - now);
  }

  private armRetireTimer(live: LivePeer, reason = 'replaced'): void {
    live.retireTimer?.clear();
    live.retireTimer = null;
    if (!live.retiring || live.finishRetired) return;
    live.retireTimer = this.scheduler.interval(() => {
      this.maybeFinishRetire(live, reason);
    }, this.nextRetireDelayMs(live));
  }

  private maybeFinishRetire(live: LivePeer, reason = 'replaced'): void {
    if (!live.retiring || live.finishRetired) return;
    if (live.streams > 0) return;
    const now = this.scheduler.now();
    const elapsed = now - live.retiredAt;
    const quietFor = live.zeroStreamsSince > 0 ? now - live.zeroStreamsSince : 0;
    if (
      (live.gotQuiesceAck && live.gotPeerQuiesce) ||
      elapsed >= PEER_RETIRE_MAX_MS ||
      (elapsed >= PEER_RETIRE_MIN_MS && quietFor >= PEER_RETIRE_QUIET_MS)
    ) {
      this.finishRetire(live, reason);
    }
  }

  private sendPeerCtl(live: LivePeer, msg: Record<string, unknown>): void {
    quiet(() => {
      void Promise.resolve(live.session.ctl.send(encodeJsonBytes(msg))).catch(() => undefined);
    });
  }

  private sendLinkHello(live: LivePeer): void {
    this.sendPeerCtl(live, { t: 'link.hello', caps: ['quiesce'] });
  }

  private probeQuiesce(live: LivePeer): void {
    if (live.probeSent || live.quiesceCapable) return;
    live.probeSent = true;
    this.sendPeerCtl(live, { t: 'link.quiesce.probe' });
  }

  private markQuiesceCapable(live: LivePeer): void {
    const already = live.quiesceCapable;
    live.quiesceCapable = true;
    if (already || live.retiring) return;
    this.activateParked(live.peerNodeId);
    if (this.upgradeGate.get(live.peerNodeId)?.coalesced) {
      this.maybeUpgrade(live.peerNodeId, { cooldown: true });
    }
    if (this.lostDirect.has(live.peerNodeId)) {
      this.armDcUpgradeRetry(live.peerNodeId);
    }
  }

  private finishRetire(live: LivePeer, reason = 'replaced'): void {
    if (live.finishRetired) {
      quiet(() => live.session.close(reason));
      return;
    }
    live.finishRetired = true;
    live.retiring = false;
    live.retireTimer?.clear();
    live.retireTimer = null;
    if (live.unsubRtc) {
      live.unsubRtc();
      live.unsubRtc = null;
    }
    this.rtcInbox.delete(live.peerNodeId);
    const set = this.retiring.get(live.peerNodeId);
    if (set) {
      set.delete(live);
      if (set.size === 0) this.retiring.delete(live.peerNodeId);
    }
    this.clearIdle(live);
    live.pingTimer?.clear();
    live.pingTimer = null;
    quiet(() => live.session.close(reason));
  }

  private forceCloseRetiring(nodeId: string, reason: string): void {
    const set = this.retiring.get(nodeId);
    if (!set) return;
    this.retiring.delete(nodeId);
    for (const live of set) {
      live.retiring = false;
      this.finishRetire(live, reason);
    }
  }

  private finishDirectAttempt(
    nodeId: string,
    attempt: DirectAttemptRecord,
    session: LinkSession | null,
    dcError: unknown
  ): void {
    const live = this.live.get(nodeId);
    if (session && live && live.transport !== 'relay') return;
    if (attempt.dc == null) noteDcOutcome(attempt, this.dcFailureReason(nodeId, dcError));
    if (hasDirectFailure(attempt))
      this.lastDirectAttempt.set(nodeId, { ...attempt, at: this.scheduler.now() });
  }

  private clearDirectFailure(nodeId: string): void {
    const prev = this.lastDirectAttempt.get(nodeId);
    if (prev) this.lastDirectAttempt.set(nodeId, clearedDirectAttempt(prev));
  }

  private dcFailureReason(nodeId: string, dcError: unknown): string | null {
    const peer = this.userStore.getPeer(nodeId);
    if (peer && peer.directCapable === false) return 'direct_capable=false';
    if (!this.rtc?.available) return 'datachannel unavailable';
    if (dcError instanceof Error) return dcError.message;
    if (dcError != null) return String(dcError);
    return null;
  }
}

function sanitizeEndpoints(value: unknown, fallbackPort?: number): string[] {
  if (typeof value === 'string') return parseEndpoints(value, fallbackPort);
  try {
    return parseEndpoints(JSON.stringify(value ?? []), fallbackPort);
  } catch {
    return [];
  }
}

function parseEndpoints(endpointsJson: string, fallbackPort?: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(endpointsJson);
  } catch {
    return [];
  }
  const urls: string[] = [];
  const push = (raw: string) => {
    if (urls.length >= PEER_MAX_ENDPOINTS) return;
    if (raw.length > PEER_MAX_ENDPOINT_LENGTH) return;
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
      urls.push(raw);
      return;
    }
    if (raw.includes('://')) return;
    const withPath = raw.includes('/peer') ? raw : `${raw}/peer`;
    const url = withPath.startsWith('ws') ? withPath : `ws://${withPath}`;
    if (url.length > PEER_MAX_ENDPOINT_LENGTH) return;
    urls.push(url);
  };
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string') {
        push(item);
      } else if (isRecord(item)) {
        if (typeof item.url === 'string') push(item.url);
        else if (typeof item.host === 'string') {
          const port = typeof item.port === 'number' ? item.port : (fallbackPort ?? 39001);
          const path = typeof item.path === 'string' ? item.path : '/peer';
          push(`ws://${item.host}:${port}${path.startsWith('/') ? path : `/${path}`}`);
        }
      }
    }
  }
  return urls;
}
