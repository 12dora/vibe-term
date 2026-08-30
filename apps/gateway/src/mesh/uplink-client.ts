import {
  bytesEqual,
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
import type { UserStore } from '../auth/user-store';
import { backoffDelayMs, defaultScheduler, jsonStable } from './ctl';
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
import {
  KEY_LOG_PAGE_DEFAULT_LIMIT,
  KEY_LOG_PAGE_MAX_LIMIT,
  UPLINK_CTL_TYPES,
  type UplinkCtlMessage,
  type UplinkEnrollRedeemed,
  type UplinkKeyLogAck,
  type UplinkKeyLogRecord,
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
  statusProvider: () => UplinkStatus;
  onNodeList?: (list: UplinkNodeList) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
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
type KeyLogHead = { seq: bigint; hash: Uint8Array };

type CatchUpCtx = {
  generation: number;
  epoch: number;
  userId: string;
  signal: AbortSignal;
};

export class UplinkClient {
  readonly identity: MeshIdentity;
  private readonly userIdOf: () => string;
  link: LinkSession | null = null;
  state: UplinkState = 'offline';

  get userId(): string {
    return this.userIdOf();
  }

  private readonly hubUrl: string;
  private readonly hubHost: string;
  private readonly keyLogApplier: KeyLogApplier;
  private readonly userStore: UserStore;
  private readonly statusProvider: () => UplinkStatus;
  private readonly onNodeListCb?: (list: UplinkNodeList) => void;
  private readonly onRtcSignalCb?: (msg: UplinkRtcSignal) => void;
  private readonly onEnrollRedeemedCb?: (msg: UplinkEnrollRedeemed) => void;
  private readonly onKeyLogForkCb?: (event: KeyLogForkEvent) => void;
  private readonly wsFactory: UplinkWsFactory;
  private readonly scheduler: MeshScheduler;
  private readonly pingIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly keyLogTimeoutMs: number;
  private readonly keyLogRetryLimit: number;
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
  private catchUpChain: Promise<void> = Promise.resolve();
  private catchUpAbort: AbortController | null = null;
  private readonly catchUpTasks = new Map<number, Set<Promise<unknown>>>();
  private readonly applierTasks = new Map<number, Set<Promise<unknown>>>();
  private readonly catchUpCancels = new Set<() => void>();
  private pendingKeyLog: {
    id: string;
    resolve: (records: UplinkKeyLogRecord[]) => void;
    reject: (err: Error) => void;
  } | null = null;
  private authenticatedGeneration = 0;
  private listEpoch = 0;
  private listVersionWatermark = Number.NEGATIVE_INFINITY;
  private latestList: UplinkNodeList | null = null;
  private lastCtlWarnAt = 0;
  private keyLogResMissingIdWarned = false;
  private readonly pendingAcks = new Map<string, (ack: UplinkKeyLogAck) => void>();
  private keyLogForked = false;
  private onlineAt = 0;
  private connectingAt = 0;
  private lastTearDownReason = '';
  private readonly lastDiagAt = new Map<string, number>();
  private customConnect: ((signal: AbortSignal) => Promise<void>) | null = null;
  lastKeyLogHead: KeyLogHead | null = null;
  lastConnectError: { reason: string; at: number } | null = null;

  constructor(opts: UplinkClientOptions) {
    this.hubUrl = opts.hubUrl;
    this.hubHost = hubHostFromUrl(opts.hubUrl);
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
    this.keyLogApplier = opts.keyLogApplier;
    this.userStore = opts.userStore;
    this.statusProvider = opts.statusProvider;
    this.onNodeListCb = opts.onNodeList;
    this.onRtcSignalCb = opts.onRtcSignal;
    this.onEnrollRedeemedCb = opts.onEnrollRedeemed;
    this.onKeyLogForkCb = opts.onKeyLogFork;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory(opts.tlsCa);
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.pingIntervalMs = opts.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS;
    this.connectTimeoutMs =
      opts.connectTimeoutMs ??
      envPositiveMs('UPLINK_CONNECT_TIMEOUT_MS', UPLINK_CONNECT_TIMEOUT_MS);
    this.authTimeoutMs = opts.authTimeoutMs ?? UPLINK_AUTH_TIMEOUT_MS;
    this.keyLogTimeoutMs = opts.keyLogTimeoutMs ?? UPLINK_KEY_LOG_ACK_TIMEOUT_MS;
    this.keyLogRetryLimit = opts.keyLogRetryLimit ?? UPLINK_KEY_LOG_RETRY_LIMIT;
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

  async connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void> {
    if (!this.stopAbort) {
      this.stopAbort = new AbortController();
    }
    if (this.state === 'offline') this.setState('connecting');
    const effective = signal ?? this.stopAbort.signal;
    const previousGeneration = this.connectGeneration;
    const previousApplier = [...(this.applierTasks.get(previousGeneration) ?? [])];
    const previousTasks = [...(this.catchUpTasks.get(previousGeneration) ?? [])];
    this.abortCatchUp();
    this.resetConnectionState();
    const generation = ++this.connectGeneration;
    this.catchUpAbort = new AbortController();
    this.link = link;
    this.bindLink(link, generation);
    const authP = this.authenticate(link, effective);
    if (previousApplier.length > 0) {
      await Promise.race([
        Promise.allSettled(previousApplier),
        this.scheduler.sleep(this.keyLogTimeoutMs),
      ]);
    }
    if (previousTasks.length > 0) {
      await Promise.allSettled(previousTasks);
    }
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
        await this.waitUntilClosed(signal);
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
        const msg = decodeUplinkCtl(bytes, { pendingKeyLogId: this.pendingKeyLog?.id });
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
    else if (msg.t === 'node.list') this.ingestNodeList(msg);
    else if (msg.t === 'key.log.res') this.handleKeyLogRes(msg);
    else if (msg.t === 'key.log.ack') {
      const waiter = this.pendingAcks.get(msg.id);
      this.pendingAcks.delete(msg.id);
      waiter?.(msg);
    } else if (msg.t === 'rtc.signal') this.onRtcSignalCb?.(msg);
    else if (msg.t === 'enroll.redeemed') this.onEnrollRedeemedCb?.(msg);
  }

  private handleKeyLogRes(msg: Extract<UplinkCtlMessage, { t: 'key.log.res' }>): void {
    const pending = this.pendingKeyLog;
    if (!pending) return;
    if (msg.id !== pending.id) {
      if (!msg.id && !this.keyLogResMissingIdWarned) {
        this.keyLogResMissingIdWarned = true;
        console.warn('[uplink] key.log.res dropped: missing id');
      }
      return;
    }
    this.pendingKeyLog = null;
    if (msg.error === 'rate_limited') {
      const hint = msg.retry_after_ms != null ? ` retry_after_ms=${msg.retry_after_ms}` : '';
      pending.reject(new Error(`rate_limited${hint}`));
      return;
    }
    if (msg.records.length > KEY_LOG_PAGE_MAX_LIMIT) {
      pending.reject(new Error('key-log-res-too-large'));
      return;
    }
    pending.resolve(msg.records);
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

  private ingestNodeList(list: UplinkNodeList): void {
    if (list.version < this.listVersionWatermark) return;
    this.listVersionWatermark = list.version;
    this.lastKeyLogHead = list.key_log_head;
    this.latestList = list;
    const generation = this.connectGeneration;
    const epoch = ++this.listEpoch;
    if (list.hub) {
      this.userStore.upsertHubMeta({
        nodeId: list.hub.nodeId,
        publicUrl: list.hub.publicUrl,
        now: this.scheduler.now(),
        listVersion: list.version,
      });
    }
    this.persistAdmittedPeers(list);
    const userId = this.userId;
    this.catchUpChain = this.catchUpChain
      .then(() => {
        if (generation !== this.connectGeneration) return;
        const work = this.catchUpFromList(list, epoch, generation, userId);
        return this.trackTask(this.catchUpTasks, generation, work);
      })
      .catch((err) => {
        this.warnCtl('handler', 'key-log.catch-up', 0, err);
      });
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

  private finishNodeList(epoch: number, generation: number): void {
    if (epoch !== this.listEpoch || generation !== this.connectGeneration) return;
    const list = this.latestList;
    if (!list) return;
    this.persistAdmittedPeers(list);
    this.onNodeListCb?.(list);
  }

  private catchUpAliveCtx(ctx: CatchUpCtx): boolean {
    return (
      !ctx.signal.aborted &&
      ctx.generation === this.connectGeneration &&
      this.isAuthenticated() &&
      !this.keyLogForked &&
      ctx.userId === this.userId
    );
  }

  private catchUpCurrent(ctx: CatchUpCtx): boolean {
    return this.catchUpAliveCtx(ctx) && ctx.epoch === this.listEpoch;
  }

  private trackTask<T>(
    map: Map<number, Set<Promise<unknown>>>,
    generation: number,
    work: Promise<T>
  ): Promise<T> {
    const set = map.get(generation) ?? new Set<Promise<unknown>>();
    map.set(generation, set);
    set.add(work);
    return work.finally(() => {
      set.delete(work);
      if (set.size === 0) map.delete(generation);
    });
  }

  private abortCatchUp(): void {
    this.catchUpAbort?.abort();
    const cancels = [...this.catchUpCancels];
    this.catchUpCancels.clear();
    for (const cancel of cancels) cancel();
  }

  private async awaitCatchUp<T>(ctx: CatchUpCtx, work: Promise<T>): Promise<T> {
    if (ctx.signal.aborted) {
      throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted');
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.catchUpCancels.delete(cancel);
        ctx.signal.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value as T);
      };
      const cancel = () => finish(new Error('aborted'));
      const onAbort = () =>
        finish(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted'));
      const timer = setTimeout(() => finish(new Error('applier-timeout')), this.keyLogTimeoutMs);
      this.catchUpCancels.add(cancel);
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => finish(undefined, value),
        (err) => finish(err instanceof Error ? err : new Error(String(err)))
      );
    });
  }

  private async catchUpFromList(
    list: UplinkNodeList,
    epoch: number,
    generation: number,
    userId: string
  ): Promise<void> {
    const ctx: CatchUpCtx = {
      generation,
      epoch,
      userId,
      signal: this.catchUpAbort?.signal ?? AbortSignal.abort(),
    };
    try {
      await this.runCatchUpFromList(list, ctx);
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === 'aborted' || err.message === 'applier-timeout')
      ) {
        return;
      }
      throw err;
    }
  }

  private awaitHead(ctx: CatchUpCtx): Promise<KeyLogHead> {
    return this.awaitCatchUp(
      ctx,
      this.trackTask(
        this.applierTasks,
        ctx.generation,
        this.keyLogApplier.head(ctx.userId, ctx.signal)
      )
    );
  }

  private async runCatchUpFromList(list: UplinkNodeList, ctx: CatchUpCtx): Promise<void> {
    if (!this.catchUpCurrent(ctx)) return;
    if (!ctx.userId) {
      console.warn('[uplink] key-log catch-up skipped: empty userId');
      this.finishNodeList(ctx.epoch, ctx.generation);
      return;
    }
    const target = list.key_log_head;
    const local = await this.readCatchUpHead(ctx);
    if (!local || !this.catchUpCurrent(ctx)) return;
    if (local.seq !== target.seq) {
      console.warn(
        `[uplink] key-log catch-up start local=${local.seq.toString()} target=${target.seq.toString()}`
      );
    }
    if (local.seq === target.seq) {
      if (!bytesEqual(local.hash, target.hash)) this.failFork(local, target);
      else this.finishNodeList(ctx.epoch, ctx.generation);
      return;
    }
    if (local.seq > target.seq) {
      if (await this.pushMissingRecords(ctx, target.seq))
        this.finishNodeList(ctx.epoch, ctx.generation);
      return;
    }
    await this.pullAndApplyPages(ctx, local, target);
  }

  private async readCatchUpHead(ctx: CatchUpCtx): Promise<KeyLogHead | null> {
    let retries = 0;
    while (this.catchUpCurrent(ctx)) {
      try {
        const local = await this.awaitHead(ctx);
        return this.catchUpCurrent(ctx) ? local : null;
      } catch (err) {
        if (!this.catchUpCurrent(ctx)) return null;
        retries += 1;
        console.warn(`[uplink] key-log head failed err=${errMsg(err)} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-head-failed', ctx.signal))) return null;
      }
    }
    return null;
  }

  private async pushMissingRecords(ctx: CatchUpCtx, hubSeq: bigint): Promise<boolean> {
    let retries = 0;
    while (this.catchUpCurrent(ctx)) {
      let pushed = false;
      try {
        pushed = await this.pushMissingToHub(ctx, hubSeq);
      } catch (err) {
        if (!this.catchUpCurrent(ctx)) return false;
        retries += 1;
        console.warn(`[uplink] key-log list/push failed err=${errMsg(err)} retry=${retries}`);
        if (!(await this.retryOrTearDown(retries, 'key-log-push-failed', ctx.signal))) return false;
        continue;
      }
      if (!this.catchUpCurrent(ctx)) return false;
      if (pushed) return true;
      retries += 1;
      if (!(await this.retryOrTearDown(retries, 'key-log-push-failed', ctx.signal))) return false;
    }
    return false;
  }

  private async pullAndApplyPages(
    ctx: CatchUpCtx,
    start: KeyLogHead,
    target: KeyLogHead
  ): Promise<void> {
    const retries = { n: 0 };
    let local = start;
    while (this.catchUpCurrent(ctx) && local.seq < target.seq) {
      const before = local;
      let records: UplinkKeyLogRecord[];
      try {
        records = await this.requestKeyLog(before.seq + 1n);
      } catch (err) {
        if (!this.catchUpCurrent(ctx)) return;
        retries.n += 1;
        console.warn(
          `[uplink] key-log catch-up request failed local=${before.seq.toString()} err=${errMsg(err)} retry=${retries.n}`
        );
        if (!(await this.retryOrTearDown(retries.n, 'key-log-catch-up-failed', ctx.signal))) return;
        continue;
      }
      if (!this.catchUpAliveCtx(ctx)) return;
      if (records.length === 0) {
        if (ctx.epoch !== this.listEpoch) return;
        retries.n += 1;
        console.warn(
          `[uplink] key-log catch-up empty res local=${before.seq.toString()} target=${target.seq.toString()} retry=${retries.n}`
        );
        if (!(await this.retryOrTearDown(retries.n, 'key-log-catch-up-failed', ctx.signal))) return;
        continue;
      }
      const sorted = [...records].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      if (sorted[0] && sorted[0].seq !== before.seq + 1n) {
        console.warn(
          `[uplink] key-log catch-up seq gap want=${(before.seq + 1n).toString()} got=${sorted[0].seq.toString()}`
        );
        this.tearDownLink('key-log-seq-gap');
        return;
      }
      const next = await this.applyCatchUpPage(ctx, before, sorted, target, retries);
      if (!next) {
        if (!this.catchUpCurrent(ctx)) return;
        continue;
      }
      local = next.local;
      if (next.reset) retries.n = 0;
    }
    this.verifyCatchUpTarget(ctx, local, target);
  }

  private async applyCatchUpPage(
    ctx: CatchUpCtx,
    before: KeyLogHead,
    records: UplinkKeyLogRecord[],
    target: KeyLogHead,
    retries: { n: number }
  ): Promise<{ local: KeyLogHead; reset: boolean } | undefined> {
    let result: { applied: number; error?: string };
    try {
      result = await this.awaitCatchUp(
        ctx,
        this.trackTask(
          this.applierTasks,
          ctx.generation,
          this.keyLogApplier.applyMany(
            ctx.userId,
            records.map((row) => ({ bytes: row.bytes, sig: row.sig })),
            ctx.signal
          )
        )
      );
    } catch (err) {
      if (!this.catchUpCurrent(ctx)) return;
      retries.n += 1;
      console.warn(`[uplink] key-log applyMany threw err=${errMsg(err)} retry=${retries.n}`);
      if (!(await this.retryOrTearDown(retries.n, 'key-log-apply-failed', ctx.signal))) return;
      return;
    }
    if (!this.catchUpAliveCtx(ctx)) return;
    let local: KeyLogHead;
    try {
      local = await this.awaitHead(ctx);
    } catch (err) {
      if (!this.catchUpCurrent(ctx)) return;
      retries.n += 1;
      console.warn(`[uplink] key-log head failed err=${errMsg(err)} retry=${retries.n}`);
      if (!(await this.retryOrTearDown(retries.n, 'key-log-head-failed', ctx.signal))) return;
      return;
    }
    if (!this.catchUpAliveCtx(ctx)) return;
    if (result.error === 'fork') {
      this.failFork(local, target);
      return;
    }
    if (ctx.epoch !== this.listEpoch) return;
    if (result.error) {
      console.warn(
        `[uplink] key-log applyMany rejected: ${result.error} applied=${result.applied}`
      );
      retries.n += 1;
      if (!(await this.retryOrTearDown(retries.n, 'key-log-apply-failed', ctx.signal))) return;
      return { local, reset: false };
    }
    if (local.seq === before.seq) {
      console.warn('[uplink] key-log catch-up stalled: head did not advance');
      retries.n += 1;
      if (!(await this.retryOrTearDown(retries.n, 'key-log-stalled', ctx.signal))) return;
      return;
    }
    return { local, reset: true };
  }

  private verifyCatchUpTarget(ctx: CatchUpCtx, local: KeyLogHead, target: KeyLogHead): void {
    if (!this.catchUpCurrent(ctx)) return;
    if (local.seq === target.seq && !bytesEqual(local.hash, target.hash)) {
      this.failFork(local, target);
      return;
    }
    if (local.seq < target.seq) {
      console.warn(
        `[uplink] key-log catch-up incomplete local=${local.seq.toString()} target=${target.seq.toString()}`
      );
      this.tearDownLink('key-log-catch-up-incomplete');
      return;
    }
    console.warn(
      `[uplink] key-log catch-up result local=${local.seq.toString()} target=${target.seq.toString()}`
    );
    this.finishNodeList(ctx.epoch, ctx.generation);
  }

  private async retryOrTearDown(
    retries: number,
    reason: string,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (retries > this.keyLogRetryLimit) {
      this.tearDownLink(reason);
      return false;
    }
    try {
      await this.scheduler.sleep(backoffDelayMs(retries - 1, 200, 2_000), signal);
      return !signal?.aborted;
    } catch {
      return false;
    }
  }

  async queryHubHead(): Promise<{ seq: bigint; hash: Uint8Array } | null> {
    return this.lastKeyLogHead;
  }

  async queryKeyLogAt(
    seq: bigint,
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS
  ): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null> {
    if (!this.link || this.state !== 'online' || this.pendingKeyLog || !this.isAuthenticated()) {
      return null;
    }
    let records: UplinkKeyLogRecord[];
    try {
      records = await this.requestKeyLog(seq, timeoutMs);
    } catch {
      return null;
    }
    const found = records.find((row) => row.seq === seq);
    return found ? { bytes: found.bytes, sig: found.sig } : null;
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array },
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS,
    generation?: number
  ): Promise<UplinkKeyLogAck> {
    if (
      (generation !== undefined && generation !== this.connectGeneration) ||
      !this.link ||
      this.state !== 'online' ||
      !this.isAuthenticated()
    ) {
      return { t: 'key.log.ack', id: '', ok: false, error: 'offline' };
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        resolve({ t: 'key.log.ack', id, ok: false, error: 'timeout' });
      }, timeoutMs);
      this.pendingAcks.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      try {
        this.link?.ctl.send(
          encodeUplinkCtl({
            t: 'key.log.append',
            bytes: record.bytes,
            sig: record.sig,
            id,
          })
        );
      } catch {
        this.pendingAcks.delete(id);
        clearTimeout(timer);
        resolve({ t: 'key.log.ack', id, ok: false, error: 'offline' });
      }
    });
  }

  private async pushMissingToHub(ctx: CatchUpCtx, hubSeq: bigint): Promise<boolean> {
    if (!this.catchUpCurrent(ctx)) return false;
    const listed = await this.awaitCatchUp(
      ctx,
      this.trackTask(
        this.applierTasks,
        ctx.generation,
        this.keyLogApplier.list?.(ctx.userId, hubSeq + 1n, ctx.signal) ?? Promise.resolve([])
      )
    );
    if (!this.catchUpCurrent(ctx)) return false;
    if (!listed || listed.length === 0) return false;
    const sorted = [...listed].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    for (const row of sorted) {
      if (!this.catchUpCurrent(ctx)) return false;
      if (row.seq <= hubSeq) continue;
      const ack = await this.appendAndAck(
        { bytes: row.bytes, sig: row.sig },
        this.keyLogTimeoutMs,
        ctx.generation
      );
      if (!this.catchUpCurrent(ctx)) return false;
      if (!ack.ok) return false;
    }
    return true;
  }

  private requestKeyLog(
    fromSeq: bigint,
    timeoutMs = this.keyLogTimeoutMs
  ): Promise<UplinkKeyLogRecord[]> {
    if (!this.link || !this.isAuthenticated()) {
      return Promise.reject(new Error('uplink-offline'));
    }
    if (this.pendingKeyLog) {
      return Promise.reject(new Error('key-log-pending'));
    }
    const id = crypto.randomUUID();
    console.warn(`[uplink] key.log.req from_seq=${fromSeq.toString()} id=${id}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingKeyLog?.id === id) {
          this.pendingKeyLog = null;
          reject(new Error('key-log-timeout'));
        }
      }, timeoutMs);
      this.pendingKeyLog = {
        id,
        resolve: (rows) => {
          clearTimeout(timer);
          resolve(rows);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      try {
        this.link?.ctl.send(
          encodeUplinkCtl({
            t: 'key.log.req',
            from_seq: fromSeq,
            id,
            limit: KEY_LOG_PAGE_DEFAULT_LIMIT,
          })
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingKeyLog = null;
        reject(err instanceof Error ? err : new Error('key-log-send-failed'));
      }
    });
  }

  private failFork(local: KeyLogHead, remote: KeyLogHead): void {
    this.keyLogForked = true;
    this.onKeyLogForkCb?.({ userId: this.userId, local, remote });
    this.tearDownLink('key_log_fork');
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
    this.abortCatchUp();
    this.stopHeartbeat();
    const pending = this.pendingKeyLog;
    this.pendingKeyLog = null;
    pending?.reject(new Error(reason));
    const acks = [...this.pendingAcks.entries()];
    this.pendingAcks.clear();
    for (const [id, waiter] of acks) {
      waiter({ t: 'key.log.ack', id, ok: false, error: 'offline' });
    }
    this.authPhase = 'idle';
    this.authenticatedGeneration = 0;
    this.latestList = null;
    this.catchUpChain = Promise.resolve();
    this.listVersionWatermark = Number.NEGATIVE_INFINITY;
    this.keyLogResMissingIdWarned = false;
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
    this.catchUpAbort = new AbortController();
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

  private waitUntilClosed(signal: AbortSignal): Promise<void> {
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
