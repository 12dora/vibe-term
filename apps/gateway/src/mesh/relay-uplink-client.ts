import { hubHostFromUrl } from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import {
  RELAY_PROTO_VERSION,
  type RelayCtlMessage,
  type RelayKickReason,
  type RelayQuota,
  type RelayRtcConfig,
  decodeRelayCtl,
  encodeRelayCtl,
  encodeRelayOpenStream,
  relaySeqFromWire,
} from '@tmex/shared/relay';
import type { UserStore } from '../auth/user-store';
import { getDisplayVersion } from '../system/version';
import { defaultScheduler, jsonStable } from './ctl';
import { stamp } from './mesh-log';
import { parseOpenPayload } from './peer-protocol';
import { RelayKeyLogSync, relayMemberFromRecord } from './relay-key-log-sync';
import {
  buildRelayStatusMessage,
  relayListToNodeList,
  relayRtcToSignal,
  relayStatusBlobOf,
  sealRelayRtcSignal,
  toUplinkEnrollRedeemed,
} from './relay-node-list';
import type { RelaySecrets } from './relay-secrets';
import {
  type RelayAuthContext,
  type RelayEnrollAck,
  type RelayEnrollCreateInput,
  buildRelayAuth,
  sendRelayEnrollCreate,
} from './relay-uplink-auth';
import { defaultRelayWsFactory, openRelayLink } from './relay-uplink-http';
import type {
  InboundRelayHandler,
  KeyLogApplier,
  MeshIdentity,
  MeshScheduler,
  UplinkState,
  UplinkStatus,
} from './types';
import {
  UPLINK_AUTH_TIMEOUT_MS,
  UPLINK_CONNECT_TIMEOUT_MS,
  UPLINK_KEY_LOG_ACK_TIMEOUT_MS,
  UPLINK_MISSED_PONG_LIMIT,
  UPLINK_PING_INTERVAL_MS,
  type UplinkWsFactory,
} from './uplink-client';
import type { UplinkCtlMessage, UplinkEnrollRedeemed, UplinkNodeList } from './uplink-protocol';

export type RelayUplinkClientOptions = {
  hubUrl: string;
  identity: MeshIdentity;
  userId: string | (() => string);
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  secrets: RelaySecrets;
  statusProvider: () => UplinkStatus;
  nameProvider?: () => string;
  onNodeList?: (list: UplinkNodeList) => void;
  onRtcSignal?: (msg: Extract<UplinkCtlMessage, { t: 'rtc.signal' }>) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onKicked?: (reason: RelayKickReason) => void;
  onQuota?: (quota: RelayQuota) => void;
  wsFactory?: UplinkWsFactory;
  tlsCa?: string[] | null;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  clientVersion?: string;
};

type AuthPhase = 'idle' | 'awaiting-challenge' | 'challenge-accepted';

/**
 * 中继上行客户端；对 `UplinkPool` 暴露与 `UplinkClient` 相同的公开面
 * （`PooledUplinkClient`），内部把 hub 的明文控制面换成 `relay/v1` 密文协议。
 */
export class RelayUplinkClient {
  readonly identity: MeshIdentity;
  readonly hubUrl: string;
  link: LinkSession | null = null;
  state: UplinkState = 'offline';
  lastConnectError: { reason: string; at: number } | null = null;
  quota: RelayQuota | null = null;
  kickedReason: RelayKickReason | null = null;
  tenantId: string | null = null;
  listVersion = 0;
  nodesViaRelay = 0;

  private readonly opts: RelayUplinkClientOptions;
  private readonly relayHost: string;
  private readonly userIdOf: () => string;
  private readonly scheduler: MeshScheduler;
  private readonly wsFactory: UplinkWsFactory;
  private readonly keyLog: RelayKeyLogSync;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private relayHandler: InboundRelayHandler | null = null;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  private heartbeat: { clear: () => void } | null = null;
  private missedPongs = 0;
  private connectGeneration = 0;
  private authenticatedGeneration = 0;
  private authPhase: AuthPhase = 'idle';
  private authWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private lastStatusJson = '';
  private rtcConfig: RelayRtcConfig = { stun: [], turn: null };

  constructor(opts: RelayUplinkClientOptions) {
    this.opts = opts;
    this.hubUrl = opts.hubUrl;
    this.relayHost = hubHostFromUrl(opts.hubUrl);
    this.identity = opts.identity;
    const uid = opts.userId;
    this.userIdOf = typeof uid === 'function' ? uid : () => uid;
    this.scheduler = opts.scheduler ?? defaultScheduler();
    this.wsFactory = opts.wsFactory ?? defaultRelayWsFactory(opts.tlsCa);
    this.keyLog = new RelayKeyLogSync({
      host: {
        generation: () => this.connectGeneration,
        isOnline: () => this.state === 'online' && this.link !== null,
        isAuthenticated: () => this.isAuthenticated(),
        userId: () => this.userId,
        send: (msg) => this.rawSend(msg),
        logKey: () => this.opts.secrets.logKey(),
        memberFor: (record) => relayMemberFromRecord(record),
      },
      applier: opts.keyLogApplier,
    });
  }

  get userId(): string {
    return this.userIdOf();
  }

  get lastKeyLogHead(): { seq: bigint; hash: Uint8Array } | null {
    const seq = this.keyLog.remoteHead;
    return seq === null ? null : { seq, hash: new Uint8Array(32) };
  }

  get rtc(): RelayRtcConfig {
    return this.rtcConfig;
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

  start(): void {
    if (this.loop) return;
    this.stopAbort = new AbortController();
    this.loop = Promise.resolve();
  }

  async attemptConnect(signal?: AbortSignal): Promise<void> {
    if (!this.stopAbort) this.stopAbort = new AbortController();
    const effective = signal ?? this.stopAbort.signal;
    if (effective.aborted) throw new Error('aborted');
    this.setState('connecting');
    try {
      await this.connectOnce(effective);
    } catch (err) {
      this.tearDownLink('connect-failed');
      this.setState('offline');
      throw err;
    }
  }

  async connectWithLink(link: LinkSession, signal?: AbortSignal): Promise<void> {
    if (!this.stopAbort) this.stopAbort = new AbortController();
    if (this.state === 'offline') this.setState('connecting');
    const effective = signal ?? this.stopAbort.signal;
    this.resetConnectionState();
    const generation = ++this.connectGeneration;
    this.link = link;
    this.bindLink(link, generation);
    await this.authenticate(link, effective, generation);
    if (effective.aborted || generation !== this.connectGeneration) throw new Error('aborted');
    this.setState('online');
    await this.sendStatusNow();
    this.startHeartbeat(link, generation);
  }

  waitUntilClosed(signal?: AbortSignal): Promise<void> {
    const effective = signal ?? this.stopAbort?.signal ?? new AbortController().signal;
    const link = this.link;
    if (!link || effective.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const onAbort = () => resolve();
      effective.addEventListener('abort', onAbort, { once: true });
      void link.closed.then(() => {
        effective.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopAbort?.abort();
    this.stopAbort = null;
    this.stopHeartbeat();
    this.tearDownLink('stopped');
    this.setState('offline');
    this.loop = null;
  }

  /** 与 hub 客户端同签名；这里把 hub 控制面消息翻译成 relay/v1。 */
  sendCtl(msg: UplinkCtlMessage): void {
    if (msg.t === 'rtc.signal') {
      void this.sendRtcSignal(msg);
      return;
    }
    if (msg.t === 'key.log.append') {
      void this.keyLog.appendAndAck({ bytes: msg.bytes, sig: msg.sig });
      return;
    }
    if (msg.t === 'ping' || msg.t === 'pong') {
      this.rawSend({ t: msg.t });
      return;
    }
    throw new Error(`relay uplink cannot send ${msg.t}`);
  }

  sendStatus(): void {
    void this.sendStatusNow();
  }

  sendStatusIfChanged(): boolean {
    if (this.state !== 'online' || !this.link) return false;
    const blob = relayStatusBlobOf(this.opts.statusProvider(), this.nameOf());
    if (jsonStable(blob) === this.lastStatusJson) return false;
    void this.sendStatusNow();
    return true;
  }

  async openRelay(toNodeId: string): Promise<LinkStream> {
    const link = this.link;
    if (!link || this.state !== 'online' || !this.isAuthenticated()) {
      throw new Error('uplink is not online');
    }
    return link.openStream(encodeRelayOpenStream({ to: toNodeId }));
  }

  async queryHubHead(): Promise<{ seq: bigint; hash: Uint8Array } | null> {
    // 中继只记 seq，没有链哈希；调用方用 queryKeyLogAt 判定重复。
    return null;
  }

  async queryKeyLogAt(seq: bigint): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null> {
    return this.keyLog.queryKeyLogAt(seq);
  }

  async appendAndAck(
    record: { bytes: Uint8Array; sig: Uint8Array; force?: boolean },
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS,
    generation?: number
  ): Promise<{ ok: boolean; seq?: bigint; error?: string }> {
    const ack = await this.keyLog.appendAndAck(
      { bytes: record.bytes, sig: record.sig },
      timeoutMs,
      generation
    );
    return {
      ok: ack.ok,
      ...(ack.seq !== undefined ? { seq: ack.seq } : {}),
      ...(ack.error ? { error: ack.error } : {}),
    };
  }

  requestCatchUpNow(): void {
    this.keyLog.schedule();
  }

  /** `POST /api/mesh/relay/enrollments` 用：把 enrollment 推给中继并等 ack。 */
  createEnrollment(
    input: RelayEnrollCreateInput,
    timeoutMs = UPLINK_KEY_LOG_ACK_TIMEOUT_MS
  ): Promise<RelayEnrollAck> {
    if (this.state !== 'online' || !this.isAuthenticated()) {
      return Promise.resolve({ ok: false, error: 'RELAY_OFFLINE' });
    }
    return sendRelayEnrollCreate(input, {
      send: (msg) => this.rawSend(msg),
      waiters: this.enrollWaiters,
      timeoutMs,
    });
  }

  private readonly enrollWaiters = new Map<string, (ack: RelayEnrollAck) => void>();

  private isAuthenticated(): boolean {
    return (
      this.authenticatedGeneration === this.connectGeneration && this.authenticatedGeneration > 0
    );
  }

  private rawSend(msg: RelayCtlMessage): void {
    const link = this.link;
    if (!link) throw new Error('uplink-offline');
    link.ctl.send(encodeRelayCtl(msg));
  }

  private setState(state: UplinkState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        /* listener errors must not break the client */
      }
    }
  }

  private connectOnce(signal: AbortSignal): Promise<void> {
    return openRelayLink(
      this.wsFactory,
      this.hubUrl,
      this.opts.connectTimeoutMs ?? UPLINK_CONNECT_TIMEOUT_MS,
      signal,
      (link, linkSignal) => this.connectWithLink(link, linkSignal)
    );
  }

  private bindLink(link: LinkSession, generation: number): void {
    link.ctl.onMessage((bytes) => {
      if (generation !== this.connectGeneration) return;
      try {
        this.handleCtl(decodeRelayCtl(bytes), generation);
      } catch (err) {
        console.warn(stamp(`[relay] ctl error err=${errMessage(err)}`));
      }
    });
    link.onStream((stream) => {
      if (generation !== this.connectGeneration || this.authenticatedGeneration !== generation) {
        stream.reset('unauthenticated');
        return;
      }
      const open = parseOpenPayload(stream.openPayload);
      const from = typeof open?.from === 'string' ? open.from : '';
      if (open?.to === this.identity.nodeId && from) this.relayHandler?.(stream, from);
    });
  }

  private handleCtl(msg: RelayCtlMessage, generation: number): void {
    if (msg.t === 'auth.challenge') {
      void this.acceptChallenge(msg.nonce, generation);
      return;
    }
    if (msg.t === 'auth.ok') {
      this.acceptAuthOk(msg, generation);
      return;
    }
    if (msg.t === 'pong') {
      this.missedPongs = 0;
      return;
    }
    if (msg.t === 'ping') {
      this.rawSend({ t: 'pong' });
      return;
    }
    if (this.authenticatedGeneration !== generation) return;
    this.handleAuthedCtl(msg);
  }

  private handleAuthedCtl(msg: RelayCtlMessage): void {
    if (msg.t === 'relay.list') void this.handleList(msg);
    else if (msg.t === 'relay.keylog.res') this.keyLog.handleRes(msg);
    else if (msg.t === 'relay.keylog.ack') this.keyLog.handleAck(msg);
    else if (msg.t === 'relay.keylog.push') this.keyLog.handlePush(msg);
    else if (msg.t === 'relay.rtc') void this.handleRtc(msg);
    else if (msg.t === 'relay.enroll.ack') this.settleEnrollAck(msg);
    else if (msg.t === 'enroll.redeemed') this.handleEnrollRedeemed(msg);
    else if (msg.t === 'relay.quota') {
      const { maxNodes, maxStreams, bandwidthBytesPerSec } = msg;
      this.quota = { maxNodes, maxStreams, bandwidthBytesPerSec };
      this.opts.onQuota?.(this.quota);
    } else if (msg.t === 'relay.kicked') {
      this.kickedReason = msg.reason;
      this.opts.onKicked?.(msg.reason);
      this.tearDownLink(`kicked:${msg.reason}`);
    }
  }

  private settleEnrollAck(msg: Extract<RelayCtlMessage, { t: 'relay.enroll.ack' }>): void {
    const waiter = this.enrollWaiters.get(msg.id);
    this.enrollWaiters.delete(msg.id);
    waiter?.({ ok: msg.ok, ...(msg.error ? { error: msg.error } : {}) });
  }

  private handleEnrollRedeemed(msg: Extract<RelayCtlMessage, { t: 'enroll.redeemed' }>): void {
    const normalized = toUplinkEnrollRedeemed(msg);
    if (normalized) this.opts.onEnrollRedeemed?.(normalized);
    else console.warn(stamp('[relay] malformed enroll.redeemed'));
  }

  private acceptAuthOk(msg: Extract<RelayCtlMessage, { t: 'auth.ok' }>, generation: number): void {
    if (this.authPhase !== 'challenge-accepted' || generation !== this.connectGeneration) return;
    this.authPhase = 'idle';
    this.authenticatedGeneration = generation;
    this.tenantId = msg.tenant_id;
    this.rtcConfig = msg.rtc;
    this.kickedReason = null;
    try {
      this.opts.secrets.store.markKicked(this.hubUrl, false);
    } catch {
      /* 行可能刚被 set-relays 换掉 */
    }
    this.authWaiter?.resolve();
    this.keyLog.noteRemoteHead(relaySeqFromWire(msg.key_log_head_seq));
  }

  private async acceptChallenge(nonceB64: string, generation: number): Promise<void> {
    if (this.authPhase !== 'awaiting-challenge' || generation !== this.connectGeneration) return;
    const built = await buildRelayAuth(this.authContext(), nonceB64);
    if (!built.ok) {
      this.authWaiter?.reject(new Error(built.error));
      return;
    }
    if (generation !== this.connectGeneration) return;
    this.authPhase = 'challenge-accepted';
    try {
      this.rawSend(built.msg);
    } catch (err) {
      this.authWaiter?.reject(err instanceof Error ? err : new Error('auth-send-failed'));
    }
  }

  private authContext(): RelayAuthContext {
    return {
      identity: this.identity,
      relayUrl: this.hubUrl,
      relayHost: this.relayHost,
      clientVersion: this.opts.clientVersion ?? getDisplayVersion(),
      secrets: this.opts.secrets,
      userStore: this.opts.userStore,
      applier: this.opts.keyLogApplier,
      userId: this.userId,
    };
  }

  private authenticate(link: LinkSession, signal: AbortSignal, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authPhase = 'awaiting-challenge';
      const timeoutMs = this.opts.authTimeoutMs ?? UPLINK_AUTH_TIMEOUT_MS;
      const timer = setTimeout(() => finish(new Error('auth-timeout')), timeoutMs);
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
      const onAbort = () => finish(new Error('aborted'));
      if (signal.aborted) {
        clearTimeout(timer);
        this.authPhase = 'idle';
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.authWaiter = { resolve: () => finish(), reject: (err) => finish(err) };
      void link.closed.then((info) => {
        if (this.authWaiter && generation === this.connectGeneration) {
          finish(new Error(info.reason || 'link-closed'));
        }
      });
    });
  }

  private nameOf(): string {
    return this.opts.nameProvider?.() ?? '';
  }

  private async sendStatusNow(): Promise<void> {
    if (this.state !== 'online' || !this.link || !this.isAuthenticated()) return;
    try {
      const built = await buildRelayStatusMessage(
        this.opts.secrets,
        this.opts.statusProvider(),
        this.nameOf()
      );
      if (!built) return;
      this.rawSend(built.msg);
      this.lastStatusJson = built.json;
    } catch (err) {
      console.warn(stamp(`[relay] status seal failed err=${errMessage(err)}`));
    }
  }

  private async handleList(msg: Extract<RelayCtlMessage, { t: 'relay.list' }>): Promise<void> {
    this.listVersion = msg.version;
    this.rtcConfig = msg.rtc;
    const list = await relayListToNodeList(msg, {
      selfNodeId: this.identity.nodeId,
      userId: this.userId,
      userStore: this.opts.userStore,
      secrets: this.opts.secrets,
      now: this.scheduler.now(),
    });
    this.nodesViaRelay = list.nodes.length;
    this.keyLog.noteRemoteHead(relaySeqFromWire(msg.key_log_head_seq));
    this.opts.onNodeList?.(list);
  }

  private async handleRtc(msg: Extract<RelayCtlMessage, { t: 'relay.rtc' }>): Promise<void> {
    const signal = await relayRtcToSignal(msg, this.opts.secrets);
    if (signal) this.opts.onRtcSignal?.(signal);
  }

  private async sendRtcSignal(msg: Extract<UplinkCtlMessage, { t: 'rtc.signal' }>): Promise<void> {
    try {
      const out = await sealRelayRtcSignal(msg, this.opts.secrets);
      if (out) this.rawSend(out);
    } catch (err) {
      console.warn(stamp(`[relay] rtc seal failed err=${errMessage(err)}`));
    }
  }

  private startHeartbeat(link: LinkSession, generation: number): void {
    this.stopHeartbeat();
    this.missedPongs = 0;
    const intervalMs = this.opts.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS;
    this.heartbeat = this.scheduler.interval(() => {
      if (generation !== this.connectGeneration || this.state !== 'online') return;
      if (this.missedPongs >= UPLINK_MISSED_PONG_LIMIT) {
        this.tearDownLink('missed-pong');
        return;
      }
      this.missedPongs += 1;
      try {
        link.ctl.send(encodeRelayCtl({ t: 'ping' }));
      } catch {
        this.tearDownLink('ping-failed');
        return;
      }
      this.sendStatusIfChanged();
    }, intervalMs);
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
    for (const waiter of this.enrollWaiters.values()) waiter({ ok: false, error: 'RELAY_OFFLINE' });
    this.enrollWaiters.clear();
    if (this.state === 'online') this.setState('connecting');
  }

  private tearDownLink(reason: string): void {
    this.resetConnectionState(reason);
    const link = this.link;
    this.link = null;
    this.connectGeneration += 1;
    this.lastConnectError = { reason, at: this.scheduler.now() };
    if (this.authWaiter) this.authWaiter.reject(new Error(reason));
    if (this.state === 'online') this.setState('connecting');
    try {
      link?.close(reason);
    } catch {
      /* already closed */
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
