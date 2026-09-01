import {
  decodeBase64url,
  encodeBase64url,
  hubHostFromUrl,
  signEd25519,
  uplinkAuthMessage,
} from '@tmex/shared/auth';
import {
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  WebSocketLink,
  type WebSocketTransportInput,
} from '@tmex/shared/link';
import type { HubAdvertisement } from '@tmex/shared/uplink';
import type { UserStore } from '../auth/user-store';
import { backoffDelayMs, defaultScheduler, jsonStable } from './ctl';
import { jsonText } from './json-text';
import { parseOpenPayload } from './peer-protocol';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import { UplinkKeyLogSync } from './uplink-key-log-sync';
import {
  UPLINK_CTL_TYPES,
  type UplinkCtlMessage,
  type UplinkEnrollRedeemed,
  type UplinkNodeList,
  type UplinkRtcSignal,
  decodeUplinkCtl,
  encodeUplinkCtl,
  uplinkWsUrl,
} from './uplink-protocol';

export const UPLINK_PING_INTERVAL_MS = 15_000;
export const UPLINK_MISSED_PONG_LIMIT = 3;
export const UPLINK_BACKOFF_MIN_MS = 1_000;
export const UPLINK_BACKOFF_MAX_MS = 60_000;
export const UPLINK_CONNECT_TIMEOUT_MS = 20_000;
export const UPLINK_AUTH_TIMEOUT_MS = 10_000;
export const UPLINK_STABLE_UPTIME_MS = 30_000;
export const UPLINK_KEY_LOG_ACK_TIMEOUT_MS = 10_000;
export const UPLINK_KEY_LOG_RETRY_LIMIT = 3;
export const UPLINK_CTL_WARN_INTERVAL_MS = 5_000;
export const UPLINK_CONNECT_LOG_INTERVAL_MS = 30_000;

export type UplinkWsFactory = (
  url: string
) => WebSocketTransportInput | Promise<WebSocketTransportInput>;

function isServerSocketAdapter(value: WebSocketTransportInput): value is ServerSocketAdapter {
  return (
    typeof (value as ServerSocketAdapter).onDrain === 'function' &&
    typeof (value as ServerSocketAdapter).onMessage === 'function'
  );
}

export type UplinkClientOptions = {
  hubUrl: string;
  identity: MeshIdentity;
  userId: string | (() => string);
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  statusProvider: () => UplinkStatus & { hub?: HubAdvertisement };
  onNodeList?: (list: UplinkNodeList) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onHubTokens?: (msg: Extract<UplinkCtlMessage, { t: 'hub.tokens' }>) => void;
  onHubAttachments?: (msg: Extract<UplinkCtlMessage, { t: 'hub.attachments' }>) => void;
  onHubForward?: (msg: Extract<UplinkCtlMessage, { t: 'hub.forward' }>) => void;
  onHubRelayStream?: (stream: LinkStream) => void;
  onKeyLogFork?: (event: KeyLogForkEvent) => void;
  wsFactory?: UplinkWsFactory;
  tlsCa?: string[] | null;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  keyLogTimeoutMs?: number;
  keyLogRetryLimit?: number;
};

export function uplinkWebSocketTls(
  tlsCa: string[] | null | undefined
): { tls: { ca: string[] } } | undefined {
  return tlsCa && tlsCa.length > 0 ? { tls: { ca: tlsCa } } : undefined;
}

function defaultWsFactory(tlsCa?: string[] | null): UplinkWsFactory {
  return (url) => {
    const tls = uplinkWebSocketTls(tlsCa);
    return tls ? new WebSocket(url, tls as never) : new WebSocket(url);
  };
}

function waitSocketOpen(
  ws: WebSocketTransportInput,
  signal: AbortSignal,
  timeoutMs: number
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
      signal.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const abortSock = (reason: string, err: Error) => {
      try {
        socket.close(1000, reason);
      } catch {
        /* ignore */
      }
      finish(err);
    };
    const onAbort = () =>
      abortSock('aborted', signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    const timer = setTimeout(
      () => abortSock('connect-timeout', new Error('connect-timeout')),
      timeoutMs
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('close', (ev) => finish(socketCloseError(ev)), { once: true });
    socket.addEventListener('error', (ev) => finish(socketErrorEvent(ev)), { once: true });
  });
}

type AuthPhase = 'idle' | 'awaiting-challenge' | 'challenge-accepted';

export class UplinkClient {
  readonly identity: MeshIdentity;
  private readonly userIdOf: () => string;
  link: LinkSession | null = null;
  state: UplinkState = 'offline';

  get userId(): string {
    return this.userIdOf();
  }

  readonly hubUrl: string;
  private readonly hubHost: string;
  private readonly userStore: UserStore;
  private readonly statusProvider: () => UplinkStatus & { hub?: HubAdvertisement };
  private readonly onNodeListCb?: (list: UplinkNodeList) => void;
  private readonly onRtcSignalCb?: (msg: UplinkRtcSignal) => void;
  private readonly onEnrollRedeemedCb?: (msg: UplinkEnrollRedeemed) => void;
  private readonly onHubTokensCb?: (msg: Extract<UplinkCtlMessage, { t: 'hub.tokens' }>) => void;
  private readonly onHubAttachmentsCb?: (
    msg: Extract<UplinkCtlMessage, { t: 'hub.attachments' }>
  ) => void;
  private readonly onHubForwardCb?: (msg: Extract<UplinkCtlMessage, { t: 'hub.forward' }>) => void;
  private readonly onHubRelayStreamCb?: (stream: LinkStream) => void;
  private readonly wsFactory: UplinkWsFactory;
  private readonly scheduler: MeshScheduler;
  private readonly pingIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly keyLog: UplinkKeyLogSync;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private relayHandler: InboundRelayHandler | null = null;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private heartbeat: { clear: () => void } | null = null;
  private missedPongs = 0;
  private lastStatusJson = '';
  private connectGeneration = 0;
  private authWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private authPhase: AuthPhase = 'idle';
  private authenticatedGeneration = 0;
  private lastCtlWarnAt = 0;
  private onlineAt = 0;
  private connectingAt = 0;
  private lastTearDownReason = '';
  private readonly lastDiagAt = new Map<string, number>();
  private customConnect: ((signal: AbortSignal) => Promise<void>) | null = null;
  lastConnectError: { reason: string; at: number } | null = null;

  get lastKeyLogHead() {
    return this.keyLog.lastKeyLogHead;
  }

  constructor(opts: UplinkClientOptions) {
    this.hubUrl = opts.hubUrl;
    this.hubHost = hubHostFromUrl(opts.hubUrl);
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
    this.userStore = opts.userStore;
    this.statusProvider = opts.statusProvider;
    this.onNodeListCb = opts.onNodeList;
    this.onRtcSignalCb = opts.onRtcSignal;
    this.onEnrollRedeemedCb = opts.onEnrollRedeemed;
    this.onHubTokensCb = opts.onHubTokens;
    this.onHubAttachmentsCb = opts.onHubAttachments;
    this.onHubForwardCb = opts.onHubForward;
    this.onHubRelayStreamCb = opts.onHubRelayStream;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory(opts.tlsCa);
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.pingIntervalMs = opts.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS;
    this.connectTimeoutMs =
      opts.connectTimeoutMs ??
      envPositiveMs('UPLINK_CONNECT_TIMEOUT_MS', UPLINK_CONNECT_TIMEOUT_MS);
    this.authTimeoutMs = opts.authTimeoutMs ?? UPLINK_AUTH_TIMEOUT_MS;
    this.keyLog = new UplinkKeyLogSync({
      host: {
        generation: () => this.connectGeneration,
        isAuthenticated: () => this.isAuthenticated(),
        userId: () => this.userId,
        isOnline: () => this.state === 'online' && this.link !== null,
        send: (bytes) => {
          const link = this.link;
          if (!link) throw new Error('uplink-offline');
          link.ctl.send(bytes);
        },
        tearDown: (reason) => this.tearDownLink(reason),
        persistList: (list) => this.persistList(list),
        emitNodeList: (list) => this.emitNodeList(list),
      },
      applier: opts.keyLogApplier,
      scheduler: this.scheduler,
      timeoutMs: opts.keyLogTimeoutMs ?? UPLINK_KEY_LOG_ACK_TIMEOUT_MS,
      retryLimit: opts.keyLogRetryLimit ?? UPLINK_KEY_LOG_RETRY_LIMIT,
      onFork: opts.onKeyLogFork,
      warnCatchUp: (err) => this.warnCtl('handler', 'key-log.catch-up', 0, err),
    });
  }

  onStateChange(cb: (state: UplinkState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  setOnRelayStream(handler: InboundRelayHandler | null): void {
    this.relayHandler = handler;
  }

  start(connectOnce?: (signal: AbortSignal) => Promise<void>): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    this.customConnect = connectOnce ?? null;
    this.loop = this.runLoop(this.stopAbort.signal);
  }

  async attemptConnect(signal?: AbortSignal): Promise<void> {
    if (this.loop) throw new Error('uplink already started');
    if (!this.stopAbort) this.stopAbort = new AbortController();
    const effective = signal ?? this.stopAbort.signal;
    if (effective.aborted) {
      throw effective.reason instanceof Error ? effective.reason : new Error('aborted');
    }
    this.connectingAt = this.scheduler.now();
    this.setState('connecting');
    try {
      await this.connectOnce(effective);
    } catch (err) {
      this.tearDownLink('connect-failed');
      this.setState('offline');
      throw err;
    }
  }

  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    return this.waitUntilClosedSignal(
      signal ?? this.stopAbort?.signal ?? new AbortController().signal
    );
  }

  async connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void> {
    if (!this.stopAbort) {
      this.stopAbort = new AbortController();
    }
    if (this.state === 'offline') this.setState('connecting');
    const effective = signal ?? this.stopAbort.signal;
    const previous = this.keyLog.snapshotTasks(this.connectGeneration);
    this.resetConnectionState();
    const generation = ++this.connectGeneration;
    this.link = link;
    this.bindLink(link, generation);
    const authP = this.authenticate(link, effective);
    await this.keyLog.awaitSnapshot(previous);
    if (effective.aborted || generation !== this.connectGeneration) {
      throw new Error('aborted');
    }
    await authP;
    if (effective.aborted || generation !== this.connectGeneration) {
      throw new Error('aborted');
    }
    this.setState('online');
    this.sendStatus();
    this.startHeartbeat(link, generation);
  }

  async stop(): Promise<void> {
    this.stopAbort?.abort();
    this.stopAbort = null;
    this.stopHeartbeat();
    this.tearDownLink('stopped');
    this.setState('offline');
    const loop = this.loop;
    this.loop = null;
    try {
      if (loop) await loop;
    } catch {
      /* cancelled */
    }
  }

  sendCtl(msg: UplinkCtlMessage): void {
    const link = this.link;
    if (!link || this.state !== 'online' || !this.isAuthenticated()) {
      throw new Error('uplink is not online');
    }
    link.ctl.send(encodeUplinkCtl(msg));
  }

  sendStatus(): void {
    if (this.state !== 'online' || !this.link || !this.isAuthenticated()) return;
    const status = this.statusProvider();
    this.lastStatusJson = jsonStable(status);
    this.link.ctl.send(
      encodeUplinkCtl({
        t: 'node.status',
        version: status.version,
        tmux: status.tmux,
        direct_capable: status.direct_capable,
        inventory: status.inventory,
        endpoints: status.endpoints,
        ...(status.hub ? { hub: status.hub } : {}),
      })
    );
  }

  sendStatusIfChanged(): boolean {
    if (this.state !== 'online' || !this.link) return false;
    const encoded = jsonStable(this.statusProvider());
    if (encoded === this.lastStatusJson) return false;
    this.sendStatus();
    return true;
  }

  async openRelay(toNodeId: string): Promise<LinkStream> {
    const link = this.link;
    if (!link || this.state !== 'online' || !this.isAuthenticated()) {
      throw new Error('uplink is not online');
    }
    return link.openStream(new TextEncoder().encode(JSON.stringify({ to: toNodeId })));
  }

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    const prev = this.state;
    if (state === 'connecting') this.connectingAt = this.scheduler.now();
    this.state = state;
    if (state === 'online') {
      this.lastTearDownReason = '';
      this.logDiag(
        'online',
        `[uplink] online hub=${this.hubHost} after_ms=${this.scheduler.now() - this.connectingAt}`
      );
    } else if (prev === 'online') {
      const reason = sanitizeUplinkReason(this.lastTearDownReason || 'disconnected');
      this.logDiag(`offline:${reason}`, `[uplink] offline reason=${reason}`);
    }
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        /* listener errors must not break the client */
      }
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      this.connectingAt = this.scheduler.now();
      this.setState('connecting');
      try {
        await (this.customConnect ? this.customConnect(signal) : this.connectOnce(signal));
        this.onlineAt = this.scheduler.now();
        await this.waitUntilClosedSignal(signal);
        if (signal.aborted) return;
        const uptime = this.scheduler.now() - this.onlineAt;
        const offlineReason = this.lastTearDownReason || 'disconnected';
        this.tearDownLink(offlineReason);
        this.setState('offline');
        if (uptime >= UPLINK_STABLE_UPTIME_MS) attempt = 0;
        const delay = backoffDelayMs(attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
        attempt += 1;
        try {
          await this.scheduler.sleep(delay, signal);
        } catch {
          return;
        }
      } catch (err) {
        this.tearDownLink('connect-failed');
        this.setState('offline');
        if (signal.aborted) return;
        const reason = classifyUplinkConnectError(err);
        const delay = backoffDelayMs(attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
        this.lastConnectError = { reason, at: this.scheduler.now() };
        if (reason !== 'aborted') this.logConnectFailed(attempt + 1, reason, delay);
        attempt += 1;
        try {
          await this.scheduler.sleep(delay, signal);
        } catch {
          return;
        }
      }
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error('connect-timeout')),
      this.connectTimeoutMs
    );
    const onParentAbort = () => {
      if (!timeout.signal.aborted) timeout.abort(signal.reason);
    };
    if (signal.aborted) onParentAbort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
    try {
      const url = uplinkWsUrl(this.hubUrl);
      const ws = await this.wsFactory(url);
      if (timeout.signal.aborted) {
        closeTransport(ws);
        throw new Error('connect-timeout');
      }
      await waitSocketOpen(ws, timeout.signal, this.connectTimeoutMs);
      const link = new WebSocketLink(ws, { role: 'initiator' });
      await this.connectWithLink(link, timeout.signal);
    } catch (err) {
      if (timeout.signal.aborted && !signal.aborted) throw new Error('connect-timeout');
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
    }
  }

  private logConnectFailed(attempt: number, reason: string, nextRetryMs: number): void {
    this.logDiag(
      `connect:${reason}`,
      `[uplink] connect failed hub=${this.hubHost} attempt=${attempt} reason=${reason} next_retry_ms=${nextRetryMs}`
    );
  }

  private logDiag(key: string, line: string): void {
    const now = this.scheduler.now();
    const prev = this.lastDiagAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (now - prev < UPLINK_CONNECT_LOG_INTERVAL_MS) return;
    this.lastDiagAt.set(key, now);
    console.warn(line);
  }

  private bindLink(link: LinkSession, generation: number): void {
    link.ctl.onMessage((bytes) => {
      if (generation !== this.connectGeneration) return;
      let type = '';
      try {
        const msg = decodeUplinkCtl(bytes, { pendingKeyLogId: this.keyLog.pendingKeyLogId });
        type = msg.t;
        try {
          this.handleCtl(msg, generation);
        } catch (err) {
          this.warnCtl('handler', type, bytes.byteLength, err);
        }
      } catch (err) {
        type = ctlTypeHint(bytes);
        this.warnCtl('decode', type, bytes.byteLength, err);
      }
    });
    link.onStream((stream) => {
      if (generation !== this.connectGeneration) return;
      if (this.authenticatedGeneration !== generation) {
        stream.reset('unauthenticated');
        return;
      }
      const open = parseOpenPayload(stream.openPayload);
      if (open?.kind === 'hub-relay') {
        this.onHubRelayStreamCb?.(stream);
        return;
      }
      const from = typeof open?.from === 'string' ? open.from : '';
      if (open?.to === this.identity.nodeId && from) this.relayHandler?.(stream, from);
    });
  }

  private authenticate(link: LinkSession, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authPhase = 'awaiting-challenge';
      const timer = setTimeout(() => finish(new Error('auth-timeout')), this.authTimeoutMs);
      const finish = (err?: Error) => {
        if (!this.authWaiter) return;
        this.authWaiter = null;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (err) {
          this.authPhase = 'idle';
          try {
            link.close(err.message);
          } catch {
            /* already closed */
          }
          reject(err);
        } else resolve();
      };
      const onAbort = () =>
        finish(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) {
        clearTimeout(timer);
        this.authPhase = 'idle';
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.authWaiter = {
        resolve: () => finish(),
        reject: (err) => finish(err),
      };
      void link.closed.then((info) => {
        if (this.authWaiter) {
          finish(new Error(info.reason || 'link-closed'));
        }
      });
    });
  }

  private isAuthenticated(): boolean {
    return (
      this.authenticatedGeneration === this.connectGeneration && this.authenticatedGeneration > 0
    );
  }

  private handleCtl(msg: UplinkCtlMessage, generation: number): void {
    if (msg.t === 'auth.challenge') this.acceptChallenge(msg.nonce);
    else if (msg.t === 'auth.ok') {
      if (this.authPhase === 'challenge-accepted' && generation === this.connectGeneration) {
        this.authPhase = 'idle';
        this.authenticatedGeneration = generation;
        this.authWaiter?.resolve();
      }
    } else if (msg.t === 'pong') this.missedPongs = 0;
    else if (msg.t === 'ping') this.link?.ctl.send(encodeUplinkCtl({ t: 'pong' }));
    else if (this.authenticatedGeneration !== generation) return;
    else if (msg.t === 'node.list') this.keyLog.ingestNodeList(msg);
    else if (msg.t === 'key.log.res') this.keyLog.handleKeyLogRes(msg);
    else if (msg.t === 'key.log.ack') this.keyLog.handleKeyLogAck(msg);
    else if (msg.t === 'rtc.signal') this.onRtcSignalCb?.(msg);
    else if (msg.t === 'enroll.redeemed') this.onEnrollRedeemedCb?.(msg);
    else if (msg.t === 'hub.tokens') this.onHubTokensCb?.(msg);
    else if (msg.t === 'hub.attachments') this.onHubAttachmentsCb?.(msg);
    else if (msg.t === 'hub.forward') this.onHubForwardCb?.(msg);
  }

  private acceptChallenge(nonceB64: string): void {
    if (this.authPhase !== 'awaiting-challenge' || !this.link) return;
    let nonce: Uint8Array;
    try {
      nonce = decodeBase64url(nonceB64);
    } catch {
      this.authWaiter?.reject(new Error('bad-nonce'));
      return;
    }
    if (nonce.byteLength !== 32) {
      this.authWaiter?.reject(new Error('bad-nonce'));
      return;
    }
    this.authPhase = 'challenge-accepted';
    const sig = signEd25519(this.identity.edSecretKey, uplinkAuthMessage(nonce, this.hubHost));
    this.link.ctl.send(
      encodeUplinkCtl({
        t: 'auth.response',
        node_id: this.identity.nodeId,
        sig: encodeBase64url(sig),
      })
    );
  }

  private persistList(list: UplinkNodeList): void {
    if (list.hub) {
      this.userStore.upsertHubMeta({
        nodeId: list.hub.nodeId,
        publicUrl: list.hub.publicUrl,
        now: this.scheduler.now(),
        listVersion: list.version,
      });
    }
  }

  private emitNodeList(list: UplinkNodeList): void {
    this.persistAdmittedPeers(list);
    this.onNodeListCb?.(list);
  }

  private persistAdmittedPeers(list: UplinkNodeList): void {
    const now = this.scheduler.now();
    for (const node of list.nodes) {
      if (node.id === this.identity.nodeId) continue;
      const cert = this.userStore.getCert(node.id);
      if (!cert || cert.userId !== this.userId || cert.revokedLogSeq != null) continue;
      this.userStore.upsertPeer({
        nodeId: node.id,
        name: node.name,
        endpointsJson: jsonText(node.endpoints),
        inventoryJson: jsonText(node.inventory),
        directCapable: node.direct_capable,
        lastSeenAt: now,
        listVersion: list.version,
      });
    }
    this.persistHubPeer(list, now);
  }

  private persistHubPeer(list: UplinkNodeList, now: number): void {
    const hub = list.hub;
    if (!hub || hub.nodeId === this.identity.nodeId) return;
    const fromNodes = list.nodes.find((node) => node.id === hub.nodeId)?.name;
    const name = usablePeerName(fromNodes, hub.nodeId) ?? usablePeerName(hub.name, hub.nodeId);
    if (!name) return;
    const cert = this.userStore.getCert(hub.nodeId);
    if (!cert || cert.userId !== this.userId || cert.revokedLogSeq != null) return;
    const existing = this.userStore.listPeers().find((row) => row.nodeId === hub.nodeId);
    this.userStore.upsertPeer({
      nodeId: hub.nodeId,
      name,
      endpointsJson: existing?.endpointsJson ?? '[]',
      inventoryJson: existing?.inventoryJson ?? '{}',
      directCapable: existing?.directCapable ?? false,
      lastSeenAt: now,
      listVersion: list.version,
    });
  }

  async queryHubHead() {
    return this.keyLog.queryHubHead();
  }

  async queryKeyLogAt(seq: bigint, timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS) {
    return this.keyLog.queryKeyLogAt(seq, timeoutMs);
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS,
    generation?: number
  ) {
    return this.keyLog.appendAndAck(record, timeoutMs, generation);
  }

  requestCatchUpNow(): void {
    this.keyLog.requestCatchUpNow();
  }

  private startHeartbeat(link: LinkSession, generation: number): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    this.heartbeat = this.scheduler.interval(() => {
      if (generation !== this.connectGeneration || this.state !== 'online') return;
      if (this.missedPongs >= UPLINK_MISSED_PONG_LIMIT) {
        this.tearDownLink('missed-pong');
        return;
      }
      this.missedPongs += 1;
      try {
        link.ctl.send(encodeUplinkCtl({ t: 'ping' }));
      } catch {
        this.tearDownLink('ping-failed');
      }
      this.sendStatusIfChanged();
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    this.heartbeat?.clear();
    this.heartbeat = null;
    this.missedPongs = 0;
  }

  private resetConnectionState(reason = 'reconnect'): void {
    this.keyLog.reset(reason);
    this.stopHeartbeat();
    this.authPhase = 'idle';
    this.authenticatedGeneration = 0;
    this.lastStatusJson = '';
    this.missedPongs = 0;
    if (this.state === 'online') this.setState('connecting');
  }

  private tearDownLink(reason: string): void {
    this.lastTearDownReason = reason;
    this.resetConnectionState(reason);
    const link = this.link;
    this.link = null;
    this.connectGeneration += 1;
    if (this.authWaiter) this.authWaiter.reject(new Error(reason));
    if (this.state === 'online') this.setState('connecting');
    try {
      link?.close(reason);
    } catch {
      /* already closed */
    }
  }

  private warnCtl(kind: 'decode' | 'handler', type: string, length: number, err: unknown): void {
    const now = this.scheduler.now();
    if (now - this.lastCtlWarnAt < UPLINK_CTL_WARN_INTERVAL_MS) return;
    this.lastCtlWarnAt = now;
    const safeType = sanitizeUplinkCtlType(type);
    const code = mapUplinkCtlError(kind, err);
    console.warn(`[uplink] ctl ${kind} error type=${safeType} len=${length} err=${code}`);
  }

  private waitUntilClosedSignal(signal: AbortSignal): Promise<void> {
    const link = this.link;
    if (!link || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => resolve();
      signal.addEventListener('abort', onAbort, { once: true });
      void link.closed.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
}

function sanitizeUplinkCtlType(type: string): string {
  return (UPLINK_CTL_TYPES as readonly string[]).includes(type) ? type : 'unknown';
}

function stripCtlControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const UPLINK_CONNECT_RULES: Array<[RegExp, string]> = [
  [/\b(enotfound|eai_again|getaddrinfo|dns)\b|name not resolved|nodename nor servname/, 'dns'],
  [/\b(econnrefused|econnreset)\b|connection refused|connect refused/, 'refused'],
  [/connect-timeout|auth-timeout|\b(etimedout|timeout|timed out)\b/, 'timeout'],
  [
    /\b(tls|ssl|cert_|err_tls|err_cert)\b|certificate|self signed|self-signed|unable to verify|hostname mismatch|altname/,
    'tls',
  ],
  [
    /\b(unauthorized|unauthenticated|unknown-cert|revoked|bad-cert|bad-sig|bad-nonce|auth_rejected)\b|auth reject|auth failed/,
    'auth_rejected',
  ],
  [/protocol|ws-closed|link-closed|invalid frame|bad upgrade/, 'protocol'],
  [/aborted/, 'aborted'],
];

export function classifyUplinkConnectError(err: unknown): string {
  const closeCode = readCloseCode(err);
  if (closeCode === 1015) return 'tls';
  if (
    closeCode != null &&
    ((closeCode >= 4400 && closeCode <= 4499) || (closeCode >= 400 && closeCode <= 599))
  ) {
    return `http_${closeCode}`;
  }
  const blob = `${readNodeErrorCode(err)} ${stripCtlControlChars(errMsg(err))}`.toLowerCase();
  for (const [re, code] of UPLINK_CONNECT_RULES) {
    if (re.test(blob)) return code;
    if (code === 'tls') {
      const http =
        blob.match(/\bhttp[_\s-]+([1-5]\d{2})\b/) ??
        blob.match(/\b(4401|4403|401|403|404|502|503)\b/);
      if (http?.[1]) return `http_${http[1]}`;
    }
  }
  return 'unknown';
}

function readCloseCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const closeCode = (err as { closeCode?: unknown }).closeCode;
  if (typeof closeCode === 'number' && Number.isFinite(closeCode)) return closeCode;
  const message = err instanceof Error ? err.message : '';
  const match = message.match(/\bws-closed (\d+)/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNodeErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function sanitizeUplinkReason(value: string): string {
  const trimmed = stripCtlControlChars(value).slice(0, 64);
  if (trimmed && /^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return trimmed;
  return classifyUplinkConnectError(new Error(trimmed));
}

function socketCloseError(ev: Event | { code?: number; reason?: string }): Error {
  const rec = ev as { code?: number; reason?: string };
  const code = typeof rec.code === 'number' ? rec.code : 0;
  const reason = typeof rec.reason === 'string' ? stripCtlControlChars(rec.reason) : '';
  const err = new Error(reason ? `ws-closed ${code} ${reason}` : `ws-closed ${code}`);
  (err as Error & { closeCode: number }).closeCode = code;
  return err;
}

function socketErrorEvent(ev: Event | { error?: unknown; message?: string }): Error {
  const rec = ev as { error?: unknown; message?: string };
  if (rec.error instanceof Error) return rec.error;
  if (typeof rec.message === 'string' && rec.message) {
    return new Error(stripCtlControlChars(rec.message));
  }
  return new Error('ws-error');
}

function closeTransport(ws: WebSocketTransportInput): void {
  try {
    if (isServerSocketAdapter(ws)) ws.close(1000, 'connect-timeout');
    else (ws as WebSocket).close(1000, 'connect-timeout');
  } catch {
    /* ignore */
  }
}

function envPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function mapUplinkCtlError(kind: 'decode' | 'handler', err: unknown): string {
  const message = stripCtlControlChars(errMsg(err));
  if (message.startsWith('unknown uplink ctl')) return 'unknown_type';
  if (message === 'ctl too large') return 'ctl_too_large';
  if (message === 'ctl too deep') return 'ctl_too_deep';
  if (message === 'ctl string too long' || message === 'ctl array too long') return 'ctl_too_long';
  if (message.startsWith('ctl field')) return 'invalid_field';
  if (message.startsWith('ctl ')) return 'invalid_ctl';
  return kind === 'decode' ? 'decode_error' : 'handler_error';
}

function ctlTypeHint(bytes: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const t =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { t?: unknown }).t
        : undefined;
    if (typeof t === 'string') return t;
  } catch {
    /* ignore */
  }
  return '';
}

function usablePeerName(name: string | null | undefined, nodeId: string): string | null {
  const trimmed = name?.trim() ?? '';
  if (!trimmed || trimmed === nodeId) return null;
  return trimmed;
}
