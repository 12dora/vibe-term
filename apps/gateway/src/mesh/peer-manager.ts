import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
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
import { defaultScheduler, encodeJsonBytes, isRecord, parseSeq } from './ctl';
import type { RtcSignalMessage } from './mesh-deps';
import { handshakeRelay, handshakeWsDirect, parseOpenPayload } from './peer-protocol';
import { PeerServer } from './peer-server';
import type { RtcPeerManager } from './rtc';
import type { RtcSignaling } from './rtc/ice';
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

/** Connection initiated by the lexicographically smaller nodeId wins a simultaneous dial. */
export function winningDialInitiator(selfNodeId: string, peerNodeId: string): string {
  return selfNodeId < peerNodeId ? selfNodeId : peerNodeId;
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
  private readonly pending = new Map<string, Promise<LinkSession>>();
  private readonly rtc: RtcPeerManager | null;
  private readonly linkFactory: PeerLinkFactory | null;
  private readonly rtcListeners = new Map<string, Set<(msg: RtcSignalMessage) => void>>();
  private readonly rtcInbox = new Map<string, RtcSignalMessage[]>();
  private readonly server: PeerServer | null;
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
    return this.server?.port ?? null;
  }

  async start(): Promise<void> {
    await this.server?.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.stopAbort.abort();
    this.server?.stop();
    for (const peer of [...this.live.values()]) {
      this.dropPeer(peer.peerNodeId, 'stopped');
    }
  }

  getLive(nodeId: string): LinkSession | null {
    const cert = this.userStore.getCert(nodeId);
    if (cert?.revokedLogSeq != null) {
      this.onRevoked(nodeId);
      return null;
    }
    return this.live.get(nodeId)?.session ?? null;
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
    inbox.push(msg);
    this.rtcInbox.set(fromNodeId, inbox);
    if (
      this.shouldTryDc(fromNodeId) &&
      !this.live.has(fromNodeId) &&
      !this.pending.has(fromNodeId)
    ) {
      void this.getLink(fromNodeId).catch(() => undefined);
    }
  }

  async getLink(nodeId: string): Promise<LinkSession> {
    if (this.stopped) throw new NodeUnreachableError(nodeId, 'peer manager stopped');
    const cert = this.userStore.getCert(nodeId);
    if (cert?.revokedLogSeq != null) {
      this.onRevoked(nodeId);
      throw new NodeUnreachableError(nodeId, 'revoked');
    }
    const existing = this.live.get(nodeId);
    if (existing) return existing.session;
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
    this.dropPeer(nodeId, 'revoked');
    this.userStore.deletePeer(nodeId);
  }

  listReach(): Map<string, PeerReach> {
    const out = new Map<string, PeerReach>();
    for (const peer of this.userStore.listPeers()) {
      const cert = this.userStore.getCert(peer.nodeId);
      if (cert?.revokedLogSeq != null) continue;
      out.set(peer.nodeId, null);
    }
    for (const [id, live] of this.live) {
      const cert = this.userStore.getCert(id);
      if (cert?.revokedLogSeq != null) {
        this.onRevoked(id);
        continue;
      }
      out.set(id, live.transport === 'relay' ? 'relay' : 'lan');
    }
    return out;
  }

  private currentGeneration(): number {
    return this.generation;
  }

  private shouldTryDc(nodeId: string): boolean {
    if (!this.rtc?.available) return false;
    const peer = this.userStore.listPeers().find((row) => row.nodeId === nodeId);
    if (peer && peer.directCapable === false) return false;
    return true;
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
      live.session.ctl.send(encodeJsonBytes(payload));
      return;
    }
    try {
      this.uplink.sendCtl(payload);
    } catch {
      // uplink offline
    }
  }

  private async dialDc(
    nodeId: string,
    gen: number,
    signal: AbortSignal
  ): Promise<LinkSession | null> {
    if (!this.rtc) return null;
    const result = await abortable(
      this.rtc.connectToPeer(nodeId, this.signalingFor(nodeId)),
      signal
    );
    if (this.stopped || gen !== this.generation) {
      try {
        result.pc.close();
      } catch {
        // ignore
      }
      throw new Error('stopped');
    }
    const session = new LinkMux(result.link, { role: result.role });
    const kept = this.track(session, result.peerNodeId, 'dc', this.identity.nodeId, gen);
    if (!kept) return null;
    return kept;
  }

  private async dial(nodeId: string): Promise<LinkSession> {
    const gen = this.currentGeneration();
    const signal = this.stopAbort.signal;
    if (this.shouldTryDc(nodeId)) {
      try {
        const dc = await this.dialDc(nodeId, gen, signal);
        if (dc) return dc;
      } catch (err) {
        if (this.stopped || gen !== this.generation) {
          throw err instanceof NodeUnreachableError
            ? err
            : new NodeUnreachableError(nodeId, 'peer manager stopped');
        }
        const live = this.live.get(nodeId);
        if (live) return live.session;
      }
    }
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
        const live = this.live.get(nodeId);
        if (live) return live.session;
      }
    }
    const cached = this.userStore.listPeers().find((row) => row.nodeId === nodeId);
    const endpoints = cached ? parseEndpoints(cached.endpointsJson, this.server?.port) : [];
    for (const url of endpoints) {
      if (this.stopped || gen !== this.generation) {
        throw new NodeUnreachableError(nodeId, 'peer manager stopped');
      }
      try {
        const session = await this.dialDirect(url, nodeId, gen, signal);
        return session;
      } catch (err) {
        if (this.stopped || gen !== this.generation) throw err;
        const live = this.live.get(nodeId);
        if (live) return live.session;
      }
    }
    const already = this.live.get(nodeId);
    if (already) return already.session;
    if (this.stopped || gen !== this.generation) {
      throw new NodeUnreachableError(nodeId, 'peer manager stopped');
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
      return kept;
    } catch (err) {
      if (err instanceof NodeUnreachableError) throw err;
      throw new NodeUnreachableError(nodeId, err instanceof Error ? err.message : 'unreachable');
    }
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
    gen: number
  ): LinkSession | null {
    if (this.stopped || gen !== this.generation) {
      try {
        session.close('stale');
      } catch {
        // already closed
      }
      return null;
    }
    const prev = this.live.get(peerNodeId);
    if (prev && prev.session !== session) {
      const winner = this.preferredInitiator(peerNodeId);
      if (initiatedBy !== winner && prev.initiatedBy === winner) {
        try {
          session.close('simultaneous-dial');
        } catch {
          // already closed
        }
        return prev.session;
      }
      this.dropPeer(peerNodeId, 'replaced');
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
    };
    this.live.set(peerNodeId, live);
    this.bindSession(live);
    this.armIdle(live);
    this.startPing(live);
    this.sendPeerStatus(live);
    return session;
  }

  private bindSession(live: LivePeer): void {
    const { session, peerNodeId } = live;
    const origOpen = session.openStream.bind(session);
    session.openStream = async (openPayload: Uint8Array) => {
      if (this.live.get(peerNodeId) !== live) {
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
      if (this.live.get(peerNodeId) !== live) {
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
    });
  }

  private onLocalStream(live: LivePeer, stream: LinkStream): void {
    live.streams += 1;
    live.lastStreamAt = this.scheduler.now();
    this.clearIdle(live);
    void stream.closed.then(() => {
      if (this.live.get(live.peerNodeId) !== live) return;
      live.streams = Math.max(0, live.streams - 1);
      live.lastStreamAt = this.scheduler.now();
      if (live.streams === 0) this.armIdle(live);
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
      });
    }
  }

  private handlePeerCtl(live: LivePeer, bytes: Uint8Array): void {
    const msg = parseOpenPayload(bytes);
    if (!msg || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'ping':
        live.session.ctl.send(encodeJsonBytes({ t: 'pong' }));
        return;
      case 'pong':
        live.missedPongs = 0;
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
        this.receiveRtcSignal(live.peerNodeId, signal);
        return;
      }
      default:
        return;
    }
  }

  private async applyPeerStatus(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    const peerNodeId = live.peerNodeId;
    const name = typeof msg.name === 'string' ? msg.name : peerNodeId;
    const existing = this.userStore.listPeers().find((row) => row.nodeId === peerNodeId);
    this.userStore.upsertPeer({
      nodeId: peerNodeId,
      name,
      endpointsJson: jsonText(msg.endpoints ?? existing?.endpointsJson ?? []),
      inventoryJson: jsonText(msg.inventory ?? existing?.inventoryJson ?? {}),
      directCapable:
        typeof msg.direct_capable === 'boolean'
          ? msg.direct_capable
          : (existing?.directCapable ?? false),
      lastSeenAt: this.scheduler.now(),
      listVersion: existing?.listVersion ?? 0,
    });
    const head = isRecord(msg.key_log_head) ? msg.key_log_head : null;
    if (!head || !this.keyLogApplier) return;
    try {
      const remoteSeq = parseSeq(head.seq, 'key_log_head.seq');
      const local = await this.keyLogApplier.head(this.uplink.userId);
      if (remoteSeq > local.seq) {
        live.session.ctl.send(
          encodeJsonBytes({ t: 'key.log.req', from_seq: Number(local.seq + 1n) })
        );
      }
    } catch {
      // ignore
    }
  }

  private async serveKeyLog(live: LivePeer, msg: Record<string, unknown>): Promise<void> {
    if (!this.keyLogApplier?.list) return;
    try {
      const fromSeq = parseSeq(msg.from_seq, 'from_seq');
      const records = await this.keyLogApplier.list(this.uplink.userId, fromSeq);
      live.session.ctl.send(
        encodeJsonBytes({
          t: 'key.log.res',
          records: records.map((row) => ({
            seq: Number(row.seq),
            bytes: encodeBase64url(row.bytes),
            sig: encodeBase64url(row.sig),
          })),
        })
      );
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
      void this.keyLogApplier.head(this.uplink.userId).then((head) => {
        payload.key_log_head = {
          seq: Number(head.seq),
          hash: encodeBase64url(head.hash),
        };
        live.session.ctl.send(encodeJsonBytes(payload));
      });
      return;
    }
    live.session.ctl.send(encodeJsonBytes(payload));
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
      try {
        live.session.ctl.send(encodeJsonBytes({ t: 'ping' }));
      } catch {
        this.dropPeer(live.peerNodeId, 'ping-failed');
      }
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
    if (!live) return;
    this.live.delete(nodeId);
    this.clearIdle(live);
    live.pingTimer?.clear();
    try {
      live.session.close(reason);
    } catch {
      // already closed
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

function parseEndpoints(endpointsJson: string, fallbackPort?: number): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(endpointsJson);
  } catch {
    return [];
  }
  const urls: string[] = [];
  const push = (raw: string) => {
    if (raw.startsWith('ws://') || raw.startsWith('wss://')) {
      urls.push(raw);
      return;
    }
    if (raw.includes('://')) return;
    const host = raw.includes('/') ? raw : raw;
    const withPath = host.includes('/peer') ? host : `${host}/peer`;
    urls.push(withPath.startsWith('ws') ? withPath : `ws://${withPath}`);
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
