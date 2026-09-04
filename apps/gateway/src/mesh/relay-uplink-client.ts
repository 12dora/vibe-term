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
import {
  type RelayDialContext,
  relayDialContextFromEnv,
  relayTlsCaForDial,
  resolveRelayDialUrl,
} from './relay-dial';
import { RelayKeyLogSync, relayMemberFromRecord } from './relay-key-log-sync';
import {
  acceptRelayEnrollRedeemed,
  acceptRelayRtcSignal,
  buildRelayStatusMessage,
  emitRelayRtcSignal,
  relayListToNodeList,
  relayStatusBlobOf,
} from './relay-node-list';
import type { RelaySecrets } from './relay-secrets';
import {
  type RelayAuthContext,
  type RelayEnrollAck,
  RelayEnrollChannel,
  type RelayEnrollCreateInput,
  buildRelayAuth,
} from './relay-uplink-auth';
import { RelayUplinkHeartbeat } from './relay-uplink-heartbeat';
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
  dial?: RelayDialContext;
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
  /** `relay.list` 串行化：blob 多的大清单解密慢，晚到的旧版本不能覆盖新版本。 */
  private listChain: Promise<void> = Promise.resolve();
  private readonly enroll: RelayEnrollChannel;

  private readonly opts: RelayUplinkClientOptions;
  private readonly relayHost: string;
  private readonly userIdOf: () => string;
  private readonly scheduler: MeshScheduler;
  private readonly heartbeat: RelayUplinkHeartbeat;
  private readonly keyLog: RelayKeyLogSync;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private relayHandler: InboundRelayHandler | null = null;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
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
    this.heartbeat = new RelayUplinkHeartbeat({
      scheduler: this.scheduler,
      intervalMs: opts.pingIntervalMs ?? UPLINK_PING_INTERVAL_MS,
      missedLimit: UPLINK_MISSED_PONG_LIMIT,
      sendPing: (link) => {
        link.ctl.send(encodeRelayCtl({ t: 'ping' }));
      },
      onTimeout: (reason) => this.tearDownLink(reason),
      onTick: () => this.sendStatusIfChanged(),
    });
    this.enroll = new RelayEnrollChannel((msg) => this.rawSend(msg));
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
  get rttMs(): number | null {
    return this.heartbeat.rttMs;
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
      this.tearDownLink(connectFailureReason(err));
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
    this.lastConnectError = null;
    this.setState('online');
    await this.sendStatusNow();
    this.heartbeat.start(
      link,
      () => generation === this.connectGeneration && this.state === 'online'
    );
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
    this.heartbeat.stop();
    this.tearDownLink('stopped');
    this.setState('offline');
    this.loop = null;
  }

  /** 与 hub 客户端同签名；这里把 hub 控制面消息翻译成 relay/v1。 */
  sendCtl(msg: UplinkCtlMessage): void {
    if (msg.t === 'rtc.signal') {
      void emitRelayRtcSignal(msg, this.opts.secrets, (out) => this.rawSend(out));
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
    return this.enroll.create(input, timeoutMs);
  }

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
    const dialUrl = resolveRelayDialUrl(this.hubUrl, this.opts.dial ?? relayDialContextFromEnv());
    const wsFactory =
      this.opts.wsFactory ?? defaultRelayWsFactory(relayTlsCaForDial(dialUrl, this.opts.tlsCa));
    return openRelayLink(
      wsFactory,
      dialUrl,
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
      this.heartbeat.onPong();
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
    if (msg.t === 'relay.list') this.enqueueList(msg);
    else if (msg.t === 'relay.keylog.res') this.keyLog.handleRes(msg);
    else if (msg.t === 'relay.keylog.ack') this.keyLog.handleAck(msg);
    else if (msg.t === 'relay.keylog.push') this.keyLog.handlePush(msg);
    else if (msg.t === 'relay.rtc') {
      void acceptRelayRtcSignal(msg, this.opts.secrets, (signal) =>
        this.opts.onRtcSignal?.(signal)
      );
    } else if (msg.t === 'relay.enroll.ack') this.enroll.settle(msg);
    else if (msg.t === 'enroll.redeemed') this.handleEnrollRedeemed(msg);
    else if (msg.t === 'relay.quota') {
      const { maxNodes, maxStreams, bandwidthBytesPerSec, currentNodes, usage } = msg;
      this.quota = {
        maxNodes,
        maxStreams,
        bandwidthBytesPerSec,
        ...(currentNodes !== undefined ? { currentNodes } : {}),
        ...(usage ? { usage } : {}),
      };
      this.opts.onQuota?.(this.quota);
    } else if (msg.t === 'relay.kicked') {
      this.kickedReason = msg.reason;
      this.opts.onKicked?.(msg.reason);
      this.tearDownLink(`kicked:${msg.reason}`);
    }
  }

  private handleEnrollRedeemed(msg: Extract<RelayCtlMessage, { t: 'enroll.redeemed' }>): void {
    const redeemed = acceptRelayEnrollRedeemed(this.opts.userStore, msg, this.scheduler.now());
    if (redeemed) this.opts.onEnrollRedeemed?.(redeemed);
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

  /** 按到达顺序串行处理，且丢掉版本不比已应用的新的清单。 */
  private enqueueList(msg: Extract<RelayCtlMessage, { t: 'relay.list' }>): void {
    const generation = this.connectGeneration;
    this.listChain = this.listChain
      .then(() => {
        if (generation !== this.connectGeneration || msg.version < this.listVersion) return;
        return this.handleList(msg);
      })
      .catch((err) => {
        console.warn(stamp(`[relay] node list failed err=${errMessage(err)}`));
      });
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
    if (msg.version < this.listVersion) return;
    this.nodesViaRelay = list.nodes.length;
    this.keyLog.noteRemoteHead(relaySeqFromWire(msg.key_log_head_seq));
    this.opts.onNodeList?.(list);
  }

  /** 密钥日志同步的健康度：跳过的记录数与第一条卡住的中继 seq。 */
  keyLogHealth(): { skipped: number; blockedSeq: string | null; caughtUp: boolean } {
    const { skipped, blockedSeq, caughtUp } = this.keyLog;
    return { skipped, blockedSeq: blockedSeq === null ? null : blockedSeq.toString(), caughtUp };
  }

  private resetConnectionState(reason = 'reconnect'): void {
    this.keyLog.reset(reason);
    this.heartbeat.reset();
    this.authPhase = 'idle';
    this.authenticatedGeneration = 0;
    this.lastStatusJson = '';
    this.enroll.reset('RELAY_OFFLINE');
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

function connectFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : '';
  if (!msg) return 'connect-failed';
  if (msg === 'aborted' || (msg.length <= 64 && /^[a-z0-9_.:-]+$/i.test(msg))) return msg;
  return 'connect-failed';
}
