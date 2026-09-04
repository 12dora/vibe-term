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
  WebSocketLink,
  type WebSocketTransportInput,
} from '@tmex/shared/link';
import { waitSocketOpen } from '@tmex/shared/net';
import type { HubAdvertisement, HubWriteForwardMessage } from '@tmex/shared/uplink';
import type { UserStore } from '../auth/user-store';
import { backoffDelayMs, defaultScheduler, jsonStable } from './ctl';
import { stamp } from './mesh-log';
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
import { persistUplinkPeerCache } from './uplink-peer-persist';
import {
  type UplinkCtlMessage,
  type UplinkEnrollRedeemed,
  type UplinkNodeList,
  type UplinkRtcSignal,
  decodeUplinkCtl,
  encodeUplinkCtl,
  uplinkWsUrl,
} from './uplink-protocol';
import {
  classifyUplinkConnectError,
  closeTransport,
  ctlTypeHint,
  envPositiveMs,
  mapUplinkCtlError,
  sanitizeUplinkCtlType,
  sanitizeUplinkReason,
} from './uplink-reconnect';

export { classifyUplinkConnectError };

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
  onHubWriteForward?: (msg: HubWriteForwardMessage) => void;
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
  private readonly onHubWriteForwardCb?: (msg: HubWriteForwardMessage) => void;
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
    this.onHubWriteForwardCb = opts.onHubWriteForward;
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
      await waitSocketOpen(ws, this.connectTimeoutMs, timeout.signal);
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
    console.warn(stamp(line));
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
    else if (msg.t === 'hub.write-forward') this.onHubWriteForwardCb?.(msg);
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
    persistUplinkPeerCache({
      userStore: this.userStore,
      userId: this.userId,
      selfNodeId: this.identity.nodeId,
      list,
      now: this.scheduler.now(),
    });
    this.onNodeListCb?.(list);
  }

  async queryHubHead() {
    return this.keyLog.queryHubHead();
  }

  async queryKeyLogAt(seq: bigint, timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS) {
    return this.keyLog.queryKeyLogAt(seq, timeoutMs);
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array; force?: boolean },
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
