import { hubHostFromUrl } from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import {
  type RelayCtlMessage,
  type RelayKickReason,
  type RelayQuota,
  type RelayRtcConfig,
  decodeRelayCtl,
  encodeRelayCtl,
  encodeRelayOpenStream,
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
import { emitRelayRtcSignal, relayStatusBlobOf } from './relay-node-list';
import type { RelaySecrets } from './relay-secrets';
import {
  type RelayEnrollAck,
  RelayEnrollChannel,
  type RelayEnrollCreateInput,
} from './relay-uplink-auth';
import {
  type AuthPhase,
  type RelayUplinkCtlHost,
  acceptRelayAuthOk,
  acceptRelayChallenge,
  authenticateRelayLink,
  dispatchRelayAuthedCtl,
  sendRelayStatusNow,
} from './relay-uplink-ctl';
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

/**
 * 中继上行客户端；对 `UplinkPool` 暴露与 `UplinkClient` 相同的公开面
 * （`PooledUplinkClient`），内部把 hub 的明文控制面换成 `relay/v1` 密文协议。
 */
export class RelayUplinkClient implements RelayUplinkCtlHost {
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
  listChain: Promise<void> = Promise.resolve();
  readonly enroll: RelayEnrollChannel;

  private readonly opts: RelayUplinkClientOptions;
  readonly relayHost: string;
  private readonly userIdOf: () => string;
  readonly scheduler: MeshScheduler;
  private readonly heartbeat: RelayUplinkHeartbeat;
  readonly keyLog: RelayKeyLogSync;
  private readonly stateListeners: Array<(state: UplinkState) => void> = [];
  private relayHandler: InboundRelayHandler | null = null;
  private loop: Promise<void> | null = null;
  private stopAbort: AbortController | null = null;
  connectGeneration = 0;
  authenticatedGeneration = 0;
  authPhase: AuthPhase = 'idle';
  authWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  lastStatusJson = '';
  rtcConfig: RelayRtcConfig = { stun: [], turn: null };

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
  get secrets(): RelaySecrets {
    return this.opts.secrets;
  }
  get userStore() {
    return this.opts.userStore;
  }
  get applier() {
    return this.opts.keyLogApplier;
  }
  get clientVersion(): string {
    return this.opts.clientVersion ?? getDisplayVersion();
  }
  get authTimeoutMs(): number {
    return this.opts.authTimeoutMs ?? UPLINK_AUTH_TIMEOUT_MS;
  }
  get statusProvider() {
    return this.opts.statusProvider;
  }
  get onNodeList() {
    return this.opts.onNodeList;
  }
  get onRtcSignal() {
    return this.opts.onRtcSignal;
  }
  get onEnrollRedeemed() {
    return this.opts.onEnrollRedeemed;
  }
  get onQuota() {
    return this.opts.onQuota;
  }
  get onKicked() {
    return this.opts.onKicked;
  }

  nodeName(): string {
    return this.opts.nameProvider?.() ?? '';
  }

  markUnkicked(): void {
    try {
      this.opts.secrets.store.markKicked(this.hubUrl, false);
    } catch {
      /* 行可能刚被 set-relays 换掉 */
    }
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
    await authenticateRelayLink(this, link, effective, generation);
    if (effective.aborted || generation !== this.connectGeneration) throw new Error('aborted');
    this.lastConnectError = null;
    this.setState('online');
    await sendRelayStatusNow(this);
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
    void sendRelayStatusNow(this);
  }

  sendStatusIfChanged(): boolean {
    if (this.state !== 'online' || !this.link) return false;
    const blob = relayStatusBlobOf(this.opts.statusProvider(), this.nodeName());
    if (jsonStable(blob) === this.lastStatusJson) return false;
    void sendRelayStatusNow(this);
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

  isAuthenticated(): boolean {
    return (
      this.authenticatedGeneration === this.connectGeneration && this.authenticatedGeneration > 0
    );
  }

  rawSend(msg: RelayCtlMessage): void {
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
    void link.closed.then((info) => {
      if (generation !== this.connectGeneration) return;
      const reason = info.reason?.trim() || 'link-closed';
      if (/^(stopped|aborted)$/i.test(reason)) return;
      this.tearDownLink(reason);
    });
  }

  private handleCtl(msg: RelayCtlMessage, generation: number): void {
    if (msg.t === 'auth.challenge') {
      void acceptRelayChallenge(this, msg.nonce, generation);
      return;
    }
    if (msg.t === 'auth.ok') {
      acceptRelayAuthOk(this, msg, generation);
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
    dispatchRelayAuthedCtl(this, msg);
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

  tearDownLink(reason: string): void {
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
