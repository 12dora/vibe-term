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
  backoffDelayMs,
  defaultScheduler,
  encodeJsonBytes,
  isRecord,
  jsonStable,
  parseSeq,
} from './ctl';
import type { RtcSignalMessage } from './mesh-deps';
import { handshakeRelay, handshakeWsDirect, parseOpenPayload } from './peer-protocol';
import { PeerServer } from './peer-server';
import type { RtcPeerManager } from './rtc';
import {
  RTC_WAKE_DOMAIN,
  RTC_WAKE_MAX_SKEW_MS,
  type RtcSignaling,
  type RtcWakeFields,
  encodeRtcWakeSdp,
  isRtcWakeSdp,
  parseRtcWakeSdp,
  peerRtcSession,
  verifyRtcWakeSignature,
} from './rtc/ice';
import { rtcLog, rtcLogRateLimited } from './rtc/rtc-log';
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

export const PEER_IDLE_MS = 5 * 60 * 1000;
export const PEER_CONNECT_TIMEOUT_MS = 3_000;
export const PEER_PING_INTERVAL_MS = 15_000;
export const PEER_MISSED_PONG_LIMIT = 3;
export const PEER_MAX_CONCURRENT_STREAMS = 256;
export const PEER_UPGRADE_COOLDOWN_MS = 10_000;
export const PEER_UPGRADE_SCAN_MS = 15_000;
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

/** Connection initiated by the lexicographically smaller nodeId wins a simultaneous dial. */
export function winningDialInitiator(selfNodeId: string, peerNodeId: string): string {
  return selfNodeId < peerNodeId ? selfNodeId : peerNodeId;
}

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
  uplink: UplinkClient;
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
  onGatewaySession?: (
    session: import('../ws/gateway-session').GatewaySession,
    auth: { sid: string; uid: string; via: string; cid?: string }
  ) => boolean | undefined;
  onGatewaySessionClose?: (session: import('../ws/gateway-session').GatewaySession) => void;
  onBrowserSignal?: (msg: RtcSignalMessage, fromNodeId?: string) => void;
  ensureDcSession?: (peerNodeId: string, rtcSession: string) => void;
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
};

type TransportWaiter = {
  kind: PeerTransportKind;
  resolve: (ok: boolean) => void;
};

type ParkedInbound = {
  session: LinkSession;
  transport: PeerTransportKind;
  initiatedBy: string;
  generation: number;
  at: number;
  timer: { clear: () => void } | null;
};

function isServerSocketAdapter(value: WebSocketTransportInput): value is ServerSocketAdapter {
  return (
    typeof (value as ServerSocketAdapter).onDrain === 'function' &&
    typeof (value as ServerSocketAdapter).onMessage === 'function'
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function waitSocketOpen(
  ws: WebSocketTransportInput,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (isServerSocketAdapter(ws)) return Promise.resolve();
  const socket = ws as WebSocket;
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      try {
        socket.close(1000, 'stopped');
      } catch {
        // ignore
      }
      finish(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      try {
        socket.close(1000, 'connect-timeout');
      } catch {
        // ignore
      }
      finish(new Error('connect-timeout'));
    }, timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('close', (ev) => finish(new Error(ev.reason || 'ws-closed')), {
      once: true,
    });
  });
}

export class PeerManager {
  readonly identity: MeshIdentity;
  private readonly userStore: UserStore;
  private readonly uplink: UplinkClient;
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
  private readonly retiring = new Map<string, Set<LivePeer>>();
  private readonly pending = new Map<string, Promise<LinkSession>>();
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
  private readonly rtcListeners = new Map<string, Set<(msg: RtcSignalMessage) => void>>();
  private readonly rtcInbox = new Map<string, RtcSignalMessage[]>();
  private readonly server: PeerServer | null;
  private readonly upgradeGate = new Map<string, UpgradeGate>();
  private readonly wakeGate = new Map<string, WakeGate>();
  private readonly incomingWakeGate = new Map<string, IncomingWakeGate>();
  private readonly rtcWakeNonces = new Map<string, true>();
  private readonly transportWaiters = new Map<string, TransportWaiter[]>();
  private upgradeInflight = 0;
  private readonly upgradeWaiters: Array<() => void> = [];
  private upgradeScan: { clear: () => void } | null = null;
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
        onAccept: (socket) => {
          void this.acceptDirect(socket);
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
    this.upgradeScan?.clear();
    this.upgradeScan = this.scheduler.interval(() => {
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
    this.abortDeferredRtcWakes();
    this.wakeGate.clear();
    this.incomingWakeGate.clear();
    this.rtcWakeNonces.clear();
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
    initiatedBy?: string
  ): LinkSession | null {
    return this.track(session, peerNodeId, transport, initiatedBy ?? peerNodeId, this.generation);
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
    if (inflight) return inflight;
    const attempt = this.dial(nodeId);
    this.pending.set(nodeId, attempt);
    try {
      return await attempt;
    } catch (err) {
      const live = this.live.get(nodeId);
      if (live) return live.session;
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    } finally {
      this.pending.delete(nodeId);
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
    this.failTransportWaiters(nodeId);
  }

  notifyPeerEndpointsChanged(nodeId?: string): void {
    if (nodeId) {
      this.maybeUpgrade(nodeId, { cooldown: true });
      return;
    }
    for (const id of this.live.keys()) {
      this.maybeUpgrade(id, { cooldown: true });
    }
  }

  refreshAdvertisedStatus(): void {
    if (!this.statusProvider) return;
    for (const live of this.live.values()) {
      this.sendPeerStatus(live);
    }
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
      out.set(id, live.transport === 'relay' ? 'relay' : 'lan');
    }
    return out;
  }

  private rememberKeys(peerNodeId: string, sendKey?: Uint8Array, recvKey?: Uint8Array): void {
    if (!sendKey || !recvKey) return;
    const live = this.live.get(peerNodeId);
    if (!live) return;
    live.sendKey = sendKey;
    live.recvKey = recvKey;
  }

  private currentGeneration(): number {
    return this.generation;
  }

  private isTrusted(nodeId: string): boolean {
    const cert = this.userStore.getCert(nodeId);
    if (!cert || cert.revokedLogSeq != null) return false;
    const uid = this.uplink.userId;
    if (!uid || cert.userId !== uid) return false;
    return true;
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
    if (live.transport === 'ws-secure') return this.shouldTryDc(live.peerNodeId);
    return this.shouldTryDc(live.peerNodeId) || this.hasWsSecureCandidate(live.peerNodeId);
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
    if (this.pending.has(nodeId)) {
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
    const before = this.live.get(nodeId)?.session ?? null;
    const upgrade = this.runUpgradeDial(nodeId, before);
    this.pending.set(nodeId, upgrade);
    void upgrade
      .catch(() => undefined)
      .finally(() => {
        if (this.pending.get(nodeId) === upgrade) this.pending.delete(nodeId);
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
    const cached = this.userStore.listPeers().find((row) => row.nodeId === nodeId);
    return cached ? parseEndpoints(cached.endpointsJson, this.server?.port).length > 0 : false;
  }

  private shouldTryDc(nodeId: string): boolean {
    if (!this.rtc?.available) return false;
    const peer = this.userStore.listPeers().find((row) => row.nodeId === nodeId);
    if (peer && peer.directCapable === false) return false;
    return true;
  }

  private handleIncomingRtcWake(fromNodeId: string, msg: RtcSignalMessage): void {
    if (this.stopped) return;
    const now = this.scheduler.now();
    let gate = this.incomingWakeGate.get(fromNodeId);
    if (!gate) {
      gate = { nextEligibleAt: 0 };
      this.incomingWakeGate.set(fromNodeId, gate);
    }
    if (now < gate.nextEligibleAt) {
      rtcLogRateLimited(`wake:rate:${fromNodeId}`, 'signal recv', {
        peer: fromNodeId,
        kind: 'wake',
        dropped: 'rate',
      });
      return;
    }
    const wake = parseRtcWakeSdp(msg.sdp);
    if (!wake || !this.acceptSignedRtcWake(fromNodeId, msg, wake)) {
      rtcLogRateLimited(`wake:auth:${fromNodeId}`, 'signal recv', {
        peer: fromNodeId,
        kind: 'wake',
        dropped: 'auth',
      });
      return;
    }
    if (this.identity.nodeId.toLowerCase() >= fromNodeId.toLowerCase()) {
      rtcLogRateLimited(`wake:role:${fromNodeId}`, 'signal recv', {
        peer: fromNodeId,
        kind: 'wake',
        dropped: 'not-offerer',
      });
      return;
    }
    gate.nextEligibleAt = now + PEER_RTC_WAKE_COOLDOWN_MS;
    rtcLog('signal recv', { peer: fromNodeId, kind: 'wake' });
    if (this.live.get(fromNodeId)?.transport === 'dc') return;
    if (!this.shouldTryDc(fromNodeId)) return;
    if (this.pending.has(fromNodeId)) return;
    const live = this.live.get(fromNodeId);
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
    if (!cert || cert.revokedLogSeq != null) return false;
    let edPk: Uint8Array;
    try {
      edPk = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      return false;
    }
    if (!verifyRtcWakeSignature(wake, edPk)) return false;
    return this.rememberRtcWakeNonce(wake.nonce);
  }

  private rememberRtcWakeNonce(nonce: string): boolean {
    if (this.rtcWakeNonces.has(nonce)) return false;
    if (this.rtcWakeNonces.size >= PEER_RTC_WAKE_NONCE_CACHE) {
      const oldest = this.rtcWakeNonces.keys().next().value;
      if (oldest !== undefined) this.rtcWakeNonces.delete(oldest);
    }
    this.rtcWakeNonces.set(nonce, true);
    return true;
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

  private maybeSendRtcWake(peerNodeId: string): void {
    this.dispatchRtcWake(peerNodeId);
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
    this.maybeSendRtcWake(nodeId);
    try {
      const result = await abortable(connectP, signal);
      if (this.stopped || gen !== this.generation) {
        this.releaseRtcAttempt(nodeId, unsub);
        unsub = null;
        try {
          result.pc.close();
        } catch {
          // ignore
        }
        throw new Error('stopped');
      }
      const session = new LinkMux(result.link, { role: result.role });
      const initiatedBy = result.role === 'initiator' ? this.identity.nodeId : result.peerNodeId;
      const kept = this.track(session, result.peerNodeId, 'dc', initiatedBy, gen);
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
      this.releaseRtcAttempt(nodeId, unsub);
      throw err;
    } finally {
      this.releaseRtcWakeAttempt(nodeId);
    }
  }

  private async dial(nodeId: string): Promise<LinkSession> {
    await Promise.resolve();
    const gen = this.currentGeneration();
    const signal = this.stopAbort.signal;
    const existingLive = this.live.get(nodeId);
    const floor = existingLive ? PEER_TRANSPORT_RANK[existingLive.transport] : 0;

    const stopped = () => this.stopped || gen !== this.generation;
    const throwIfStopped = (err?: unknown) => {
      if (!stopped()) return;
      throw err instanceof NodeUnreachableError
        ? err
        : new NodeUnreachableError(nodeId, 'peer manager stopped');
    };

    let dcError: unknown = null;
    if (PEER_TRANSPORT_RANK.dc > floor && this.shouldTryDc(nodeId)) {
      try {
        const dc = await this.dialDc(nodeId, gen, signal);
        if (dc) return dc;
      } catch (err) {
        dcError = err;
        throwIfStopped(err);
      }
    }

    if (PEER_TRANSPORT_RANK['ws-secure'] > floor) {
      if (dcError) {
        rtcLog('dial failed', {
          peer: nodeId,
          reason: dcError instanceof Error ? dcError.message : String(dcError),
          fallback: 'ws-secure',
        });
      }
      const ws = await this.dialWsSecure(nodeId, gen, signal);
      if (ws) return ws;
      throwIfStopped();
    }

    const already = this.live.get(nodeId);
    if (already) return already.session;
    throwIfStopped();

    if (dcError != null || (PEER_TRANSPORT_RANK.dc > floor && this.shouldTryDc(nodeId))) {
      rtcLog('dial failed', {
        peer: nodeId,
        reason:
          dcError instanceof Error
            ? dcError.message
            : dcError
              ? String(dcError)
              : 'datachannel unavailable',
        fallback: 'relay',
      });
    }

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
      const kept = this.track(
        result.session,
        result.peerNodeId,
        'relay',
        this.identity.nodeId,
        gen
      );
      if (!kept) {
        throw new NodeUnreachableError(nodeId, 'simultaneous-dial');
      }
      this.rememberKeys(result.peerNodeId, result.sendKey, result.recvKey);
      return kept;
    } catch (err) {
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
  }

  private async dialWsSecure(
    nodeId: string,
    gen: number,
    signal: AbortSignal
  ): Promise<LinkSession | null> {
    if (this.linkFactory) {
      try {
        const session = await abortable(Promise.resolve(this.linkFactory(nodeId, signal)), signal);
        if (session) {
          if (this.stopped || gen !== this.generation) {
            try {
              session.close('stopped');
            } catch {
              // ignore
            }
            throw new NodeUnreachableError(nodeId, 'peer manager stopped');
          }
          const kept = this.track(session, nodeId, 'ws-secure', this.identity.nodeId, gen);
          if (kept) return kept;
        }
      } catch (err) {
        if (this.stopped || gen !== this.generation) {
          throw err instanceof NodeUnreachableError
            ? err
            : new NodeUnreachableError(nodeId, 'peer manager stopped');
        }
      }
    }
    const cached = this.userStore.listPeers().find((row) => row.nodeId === nodeId);
    const endpoints = cached ? parseEndpoints(cached.endpointsJson, this.server?.port) : [];
    for (const url of endpoints) {
      if (this.stopped || gen !== this.generation) {
        throw new NodeUnreachableError(nodeId, 'peer manager stopped');
      }
      try {
        return await this.dialDirect(url, nodeId, gen, signal);
      } catch (err) {
        if (this.stopped || gen !== this.generation) throw err;
      }
    }
    return null;
  }

  private async dialDirect(
    url: string,
    expectedId: string,
    gen: number,
    signal: AbortSignal
  ): Promise<LinkSession> {
    const ws = await abortable(Promise.resolve(this.wsFactory(url)), signal);
    await waitSocketOpen(ws, this.connectTimeoutMs, signal);
    if (this.stopped || gen !== this.generation) {
      try {
        if (isServerSocketAdapter(ws)) ws.close(1000, 'stopped');
        else (ws as WebSocket).close(1000, 'stopped');
      } catch {
        // ignore
      }
      throw new Error('stopped');
    }
    const result = await handshakeWsDirect({
      socket: ws,
      role: 'initiator',
      identity: this.identity,
      userStore: this.userStore,
    });
    if (result.peerNodeId !== expectedId) {
      result.session.close('peer-id-mismatch');
      throw new Error('peer-id-mismatch');
    }
    if (this.stopped || gen !== this.generation) {
      result.session.close('stopped');
      throw new Error('stopped');
    }
    const kept = this.track(
      result.session,
      result.peerNodeId,
      'ws-secure',
      this.identity.nodeId,
      gen
    );
    if (!kept) throw new Error('simultaneous-dial');
    this.rememberKeys(result.peerNodeId, result.sendKey, result.recvKey);
    return kept;
  }

  private async acceptDirect(socket: ServerSocketAdapter): Promise<void> {
    const gen = this.currentGeneration();
    try {
      const result = await handshakeWsDirect({
        socket,
        role: 'acceptor',
        identity: this.identity,
        userStore: this.userStore,
      });
      if (this.stopped || gen !== this.generation) {
        result.session.close('stopped');
        return;
      }
      this.track(result.session, result.peerNodeId, 'ws-secure', result.peerNodeId, gen);
      this.rememberKeys(result.peerNodeId, result.sendKey, result.recvKey);
    } catch {
      try {
        socket.close(1000, 'handshake-failed');
      } catch {
        // already closed
      }
    }
  }

  private async acceptRelay(stream: LinkStream, from: string): Promise<void> {
    const gen = this.currentGeneration();
    try {
      const result = await handshakeRelay({
        stream,
        role: 'acceptor',
        identity: this.identity,
        userStore: this.userStore,
      });
      if (this.stopped || gen !== this.generation) {
        result.session.close('stopped');
        return;
      }
      this.track(result.session, result.peerNodeId, 'relay', from || result.peerNodeId, gen);
      this.rememberKeys(result.peerNodeId, result.sendKey, result.recvKey);
    } catch {
      try {
        stream.reset('handshake-failed');
      } catch {
        // already closed
      }
    }
  }

  private preferredInitiator(peerNodeId: string): string {
    return winningDialInitiator(this.identity.nodeId, peerNodeId);
  }

  private track(
    session: LinkSession,
    peerNodeId: string,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number,
    quiesceCapable = false
  ): LinkSession | null {
    if (this.stopped || gen !== this.generation) {
      try {
        session.close('stale');
      } catch {
        // already closed
      }
      return null;
    }
    if (!this.isTrusted(peerNodeId)) {
      try {
        session.close('not-trusted');
      } catch {
        // already closed
      }
      return null;
    }
    const prev = this.live.get(peerNodeId);
    if (prev && prev.session !== session) {
      const rank = comparePeerTransport(transport, prev.transport);
      if (rank < 0) {
        try {
          session.close('lower-priority');
        } catch {
          // already closed
        }
        return prev.session;
      }
      if (rank === 0) {
        const winner = this.preferredInitiator(peerNodeId);
        if (initiatedBy !== winner && prev.initiatedBy === winner) {
          try {
            session.close('simultaneous-dial');
          } catch {
            // already closed
          }
          return prev.session;
        }
      }
      if (!prev.quiesceCapable) {
        this.parkInbound(peerNodeId, session, transport, initiatedBy, gen);
        this.probeQuiesce(prev);
        return prev.session;
      }
      this.retirePeer(prev, 'replaced');
    }
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
      quiesceCapable,
      helloReplied: false,
      probeSent: false,
    };
    this.live.set(peerNodeId, live);
    this.bindSession(live);
    if (!live.quiesceCapable) this.sendLinkHello(live);
    this.armIdle(live);
    this.startPing(live);
    this.sendPeerStatus(live);
    this.notifyTransport(peerNodeId);
    return session;
  }

  private bindSession(live: LivePeer): void {
    const { session, peerNodeId } = live;
    const origOpen = session.openStream.bind(session);
    session.openStream = async (openPayload: Uint8Array) => {
      if (live.retiring || this.live.get(peerNodeId) !== live) {
        throw new Error('peer link replaced');
      }
      if (live.streams >= this.maxConcurrentStreams) {
        throw new Error('too-many-streams');
      }
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
    void session.closed.then(() => {
      if (this.live.get(peerNodeId)?.session === session) {
        this.dropPeer(peerNodeId, 'closed');
      }
      const set = this.retiring.get(peerNodeId);
      if (set) {
        for (const row of [...set]) {
          if (row.session === session) this.finishRetire(row, 'closed');
        }
      }
    });
  }

  private onLocalStream(live: LivePeer, stream: LinkStream): void {
    live.streams += 1;
    live.lastStreamAt = this.scheduler.now();
    live.zeroStreamsSince = 0;
    this.clearIdle(live);
    void stream.closed.then(() => {
      live.streams = Math.max(0, live.streams - 1);
      live.lastStreamAt = this.scheduler.now();
      if (live.streams === 0) live.zeroStreamsSince = this.scheduler.now();
      if (live.streams > 0) return;
      if (live.retiring) {
        this.maybeFinishRetire(live);
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
    switch (msg.t) {
      case 'ping':
        this.sendPeerCtl(live, { t: 'pong' });
        return;
      case 'pong':
        live.missedPongs = 0;
        return;
      case 'link.hello': {
        const caps = Array.isArray(msg.caps) ? msg.caps : [];
        if (caps.includes('quiesce')) this.markQuiesceCapable(live);
        if (!live.helloReplied) {
          live.helloReplied = true;
          this.sendLinkHello(live);
        }
        return;
      }
      case 'link.quiesce.probe':
        this.markQuiesceCapable(live);
        this.sendPeerCtl(live, { t: 'link.quiesce.probe.ack' });
        return;
      case 'link.quiesce.probe.ack':
        this.markQuiesceCapable(live);
        return;
      case 'link.quiesce':
        live.gotPeerQuiesce = true;
        this.markQuiesceCapable(live);
        this.sendPeerCtl(live, { t: 'link.quiesce.ack' });
        if (live.retiring) this.maybeFinishRetire(live);
        return;
      case 'link.quiesce.ack':
        live.gotQuiesceAck = true;
        this.markQuiesceCapable(live);
        if (live.retiring) this.maybeFinishRetire(live);
        return;
      case 'node.status':
        void this.applyPeerStatus(live, msg);
        return;
      case 'key.log.req':
        void this.serveKeyLog(live, msg);
        return;
      case 'key.log.res':
        void this.applyKeyLogRes(msg);
        return;
      case 'rtc.signal': {
        const signal: RtcSignalMessage = {
          rtcSession: typeof msg.rtcSession === 'string' ? msg.rtcSession : '',
          from: msg.from === 'browser' ? 'browser' : 'node',
          to: typeof msg.to === 'string' ? msg.to : '',
          sdp: typeof msg.sdp === 'string' ? msg.sdp : null,
          candidate: typeof msg.candidate === 'string' ? msg.candidate : null,
        };
        if (signal.from === 'browser') {
          this.onBrowserSignal?.(signal, live.peerNodeId);
          return;
        }
        this.receiveRtcSignal(live.peerNodeId, signal);
        return;
      }
      default:
        return;
    }
  }

  private async applyPeerStatus(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    if (!this.isTrusted(live.peerNodeId)) return;
    const peerNodeId = live.peerNodeId;
    const name = typeof msg.name === 'string' ? msg.name : peerNodeId;
    const existing = this.userStore.listPeers().find((row) => row.nodeId === peerNodeId);
    this.userStore.upsertPeer({
      nodeId: peerNodeId,
      name,
      endpointsJson: jsonText(
        sanitizeEndpoints(msg.endpoints ?? existing?.endpointsJson ?? [], this.server?.port)
      ),
      inventoryJson: jsonText(msg.inventory ?? existing?.inventoryJson ?? {}),
      directCapable:
        typeof msg.direct_capable === 'boolean'
          ? msg.direct_capable
          : (existing?.directCapable ?? false),
      lastSeenAt: this.scheduler.now(),
      listVersion: existing?.listVersion ?? 0,
    });
    this.notifyPeerEndpointsChanged(peerNodeId);
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
    try {
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
    } catch {
      // ignore
    }
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
    const encoded = jsonStable(status);
    if (encoded === live.lastAdvertisedStatusJson) return;
    live.lastAdvertisedStatusJson = encoded;
    const payload: Record<string, unknown> = {
      t: 'node.status',
      version: status.version,
      tmux: status.tmux,
      direct_capable: status.direct_capable,
      inventory: status.inventory,
      endpoints: status.endpoints,
      name: status.name,
    };
    if (this.keyLogApplier) {
      void this.keyLogApplier
        .head(this.uplink.userId)
        .then((head) => {
          if (this.live.get(live.peerNodeId) !== live && !live.retiring) return;
          payload.key_log_head = {
            seq: Number(head.seq),
            hash: encodeBase64url(head.hash),
          };
          this.sendPeerCtl(live, payload);
        })
        .catch(() => undefined);
      return;
    }
    this.sendPeerCtl(live, payload);
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
      this.sendPeerCtl(live, { t: 'ping' });
    }, PEER_PING_INTERVAL_MS);
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
      Math.min(this.idleMs, 1_000)
    );
  }

  private clearIdle(live: LivePeer): void {
    live.idleTimer?.clear();
    live.idleTimer = null;
  }

  private dropPeer(nodeId: string, reason: string): void {
    const live = this.live.get(nodeId);
    if (live) {
      this.live.delete(nodeId);
      this.finishRetire(live, reason);
    }
    this.incomingWakeGate.delete(nodeId);
    this.notifyTransport(nodeId);
    if (this.stopped || reason === 'revoked') {
      this.dropParked(nodeId, reason);
      return;
    }
    this.activateParked(nodeId);
  }

  private parkInbound(
    peerNodeId: string,
    session: LinkSession,
    transport: PeerTransportKind,
    initiatedBy: string,
    gen: number
  ): void {
    const existing = this.parked.get(peerNodeId);
    const parkedAt = existing?.at ?? this.scheduler.now();
    if (existing) {
      this.parked.delete(peerNodeId);
      existing.timer?.clear();
      this.parkedSessions.delete(existing.session);
      try {
        existing.session.close('replaced-park');
      } catch {
        // already closed
      }
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
    };
    parked.timer = this.scheduler.interval(() => {
      if (this.parked.get(peerNodeId) !== parked) return;
      if (this.scheduler.now() - parked.at >= PEER_RETIRE_MAX_MS) {
        this.dropParked(peerNodeId, 'park-timeout');
      }
    }, 250);
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
      try {
        stream.reset('parked');
      } catch {
        // already closed
      }
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
    try {
      parked.session.close(reason);
    } catch {
      // already closed
    }
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
    this.track(parked.session, nodeId, parked.transport, parked.initiatedBy, parked.generation);
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
    prev.retireTimer?.clear();
    prev.retireTimer = this.scheduler.interval(() => {
      this.maybeFinishRetire(prev, reason);
    }, 250);
    this.maybeFinishRetire(prev, reason);
  }

  private maybeFinishRetire(live: LivePeer, reason = 'replaced'): void {
    if (!live.retiring || live.finishRetired) return;
    if (live.streams > 0) return;
    const now = this.scheduler.now();
    const elapsed = now - live.retiredAt;
    if (live.gotQuiesceAck && live.gotPeerQuiesce) {
      this.finishRetire(live, reason);
      return;
    }
    if (elapsed >= PEER_RETIRE_MAX_MS) {
      this.finishRetire(live, reason);
      return;
    }
    const quietFor = live.zeroStreamsSince > 0 ? now - live.zeroStreamsSince : 0;
    if (elapsed >= PEER_RETIRE_MIN_MS && quietFor >= PEER_RETIRE_QUIET_MS) {
      this.finishRetire(live, reason);
    }
  }

  private sendPeerCtl(live: LivePeer, msg: Record<string, unknown>): void {
    try {
      void Promise.resolve(live.session.ctl.send(encodeJsonBytes(msg))).catch(() => undefined);
    } catch {
      // link may already be closing
    }
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
  }

  private finishRetire(live: LivePeer, reason = 'replaced'): void {
    if (live.finishRetired) {
      try {
        live.session.close(reason);
      } catch {
        // already closed
      }
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
    try {
      live.session.close(reason);
    } catch {
      // already closed
    }
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
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value ?? null);
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
    const host = raw.includes('/') ? raw : raw;
    const withPath = host.includes('/peer') ? host : `${host}/peer`;
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
