import { encodeBase64url, hubHostFromUrl, randomBytes } from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import {
  MIN_RELAY_CLIENT_VERSION,
  RELAY_CTL_MAX_BYTES,
  type RelayCtlMessage,
  type RelayKickReason,
  type RelayQuota,
  type RelayQuotaUsage,
  type RelayRtcConfig,
  decodeRelayCtl,
  encodeRelayCtl,
} from '@tmex/shared/relay';
import type { AuthDb } from '../auth/types';
import type { RelayConfigStore } from './relay-config-store';
import { RelayCtlQueue } from './relay-ctl-queue';
import { RelayEnrollCreateRate } from './relay-enroll-limiter';
import { pageRelayKeyLog } from './relay-key-log-service';
import type { RelayKeyLogStore } from './relay-key-log-store';
import type { RelayMetering } from './relay-metering';
import { type RelayListDeps, encodeRelayList } from './relay-node-list';
import { type RelaySleep, RelayTokenBucket, effectiveRelayQuota } from './relay-quota';
import { relayQuotaCtl, relayQuotaUsageFingerprint } from './relay-quota-ctl';
import {
  type RelayLiveNode,
  type RelayRegistry,
  noteRelayPing,
  noteRelayPong,
} from './relay-registry';
import { acceptRelayStream } from './relay-stream-router';
import type { RelayTenantStore } from './relay-tenant-store';
import { handleRelayAuth, liveAuthStillValid } from './relay-uplink-auth';
import {
  type RelayUplinkHost,
  handleRelayEnrollCreate,
  handleRelayKeyLogAppend,
  handleRelayRtc,
} from './relay-uplink-handlers';
import {
  RELAY_AUTH_TIMEOUT_MS,
  RELAY_ENROLLMENT_USED_RETENTION_MS,
  RELAY_HEARTBEAT_INTERVAL_MS,
  RELAY_HEARTBEAT_MISS_LIMIT,
  RELAY_LIST_DEBOUNCE_MS,
  type RelayRuntimeConfig,
} from './types';

type PendingAuth = { nonce: Uint8Array };

export type RelayUplinkServerOptions = {
  db: AuthDb;
  tenants: RelayTenantStore;
  keyLog: RelayKeyLogStore;
  configStore: RelayConfigStore;
  registry: RelayRegistry;
  metering: RelayMetering;
  config: RelayRuntimeConfig;
  now?: () => number;
  sleep?: RelaySleep;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
  listDebounceMs?: number;
  minClientVersion?: string;
  /** 测试钩子：precondition 通过之后、注册 live 连接之前。 */
  authBarrier?: () => Promise<void>;
  tenantRates?: (tenantId: string) => {
    bytesInPerSec: number;
    bytesOutPerSec: number;
    bandwidthBytesPerSec: number;
  };
};

export class RelayUplinkServer implements RelayUplinkHost {
  readonly relayHost: string;
  readonly db: AuthDb;
  readonly tenants: RelayTenantStore;
  readonly keyLog: RelayKeyLogStore;
  readonly registry: RelayRegistry;
  readonly now: () => number;
  private readonly configStore: RelayConfigStore;
  private readonly metering: RelayMetering;
  private readonly config: RelayRuntimeConfig;
  private readonly sleep: RelaySleep | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMissLimit: number;
  private readonly authTimeoutMs: number;
  private readonly listDebounceMs: number;
  private readonly minClientVersion: string;
  private readonly authBarrier: (() => Promise<void>) | undefined;
  private readonly pending = new WeakMap<LinkSession, PendingAuth>();
  private readonly accepted = new Set<LinkSession>();
  private readonly authTimers = new Map<LinkSession, ReturnType<typeof setTimeout>>();
  private readonly ctlQueue = new RelayCtlQueue();
  private readonly listTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly buckets = new Map<string, RelayTokenBucket>();
  private readonly closeTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly listDeps: RelayListDeps;
  private readonly enrollCreates: RelayEnrollCreateRate;
  private listVersion = 0;
  private stopped = false;
  private tenantRates:
    | ((tenantId: string) => {
        bytesInPerSec: number;
        bytesOutPerSec: number;
        bandwidthBytesPerSec: number;
      })
    | undefined;
  private readonly lastUsagePush = new Map<string, string>();

  constructor(opts: RelayUplinkServerOptions) {
    this.db = opts.db;
    this.tenants = opts.tenants;
    this.enrollCreates = new RelayEnrollCreateRate(opts.now ?? Date.now);
    this.keyLog = opts.keyLog;
    this.configStore = opts.configStore;
    this.registry = opts.registry;
    this.metering = opts.metering;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? RELAY_HEARTBEAT_INTERVAL_MS;
    this.heartbeatMissLimit = opts.heartbeatMissLimit ?? RELAY_HEARTBEAT_MISS_LIMIT;
    this.authTimeoutMs = opts.authTimeoutMs ?? RELAY_AUTH_TIMEOUT_MS;
    this.listDebounceMs = opts.listDebounceMs ?? RELAY_LIST_DEBOUNCE_MS;
    this.minClientVersion = opts.minClientVersion ?? MIN_RELAY_CLIENT_VERSION;
    this.authBarrier = opts.authBarrier;
    this.tenantRates = opts.tenantRates;
    this.relayHost = hubHostFromUrl(opts.config.publicUrl);
    this.listDeps = {
      tenants: this.tenants,
      registry: this.registry,
      rtc: () => this.rtcConfig(),
      nextVersion: () => {
        this.listVersion += 1;
        return this.listVersion;
      },
    };
  }

  openSocketCount(): number {
    return this.accepted.size;
  }

  accept(link: LinkSession): void {
    if (this.stopped) {
      link.close('relay-stop');
      return;
    }
    const nonce = randomBytes(32);
    this.accepted.add(link);
    this.pending.set(link, { nonce });
    this.armAuthTimer(link);
    this.send(link, { t: 'auth.challenge', nonce: encodeBase64url(nonce) });
    link.ctl.onMessage((bytes) => {
      void this.enqueueCtl(link, bytes);
    });
    link.onStream((stream) => {
      void this.onIncomingStream(link, stream);
    });
    void link.closed.then(() => {
      this.onLinkClosed(link);
    });
  }

  rtcConfig(): RelayRtcConfig {
    return { stun: [...this.config.stun], turn: this.config.turn ?? null };
  }

  bindTenantRates(
    tenantRates: (tenantId: string) => {
      bytesInPerSec: number;
      bytesOutPerSec: number;
      bandwidthBytesPerSec: number;
    }
  ): void {
    this.tenantRates = tenantRates;
  }

  quotaFor(tenantId: string): RelayQuota {
    const tenant = this.tenants.get(tenantId);
    return effectiveRelayQuota(
      tenant?.quota ?? null,
      this.configStore.ensure(this.now()).defaultQuota
    );
  }

  quotaUsage(tenantId: string): RelayQuotaUsage {
    const rates = this.tenantRates?.(tenantId);
    return {
      currentNodes: this.tenants.countActiveNodes(tenantId),
      currentStreams: this.registry.streamCount(tenantId),
      bytesInPerSec: rates?.bytesInPerSec ?? 0,
      bytesOutPerSec: rates?.bytesOutPerSec ?? 0,
      bandwidthBytesPerSec: rates?.bandwidthBytesPerSec ?? 0,
      sampledAt: this.now(),
    };
  }

  bucketFor(tenantId: string): RelayTokenBucket {
    const rate = this.quotaFor(tenantId).bandwidthBytesPerSec;
    const existing = this.buckets.get(tenantId);
    if (existing) {
      if (existing.rateBytesPerSec !== rate) existing.setRate(rate);
      return existing;
    }
    const bucket = new RelayTokenBucket(rate, this.now, this.sleep);
    this.buckets.set(tenantId, bucket);
    return bucket;
  }

  /** 配额变更后立刻把新值推给该租户在线节点，并重置带宽桶速率。 */
  notifyQuota(tenantId: string): void {
    const quota = this.quotaFor(tenantId);
    this.buckets.get(tenantId)?.setRate(quota.bandwidthBytesPerSec);
    const usage = this.quotaUsage(tenantId);
    this.lastUsagePush.set(tenantId, relayQuotaUsageFingerprint(usage));
    this.broadcast(tenantId, relayQuotaCtl(quota, usage.currentNodes, usage));
  }

  /** 采样拍：用量有变才推；刚接入的租户由 `notifyQuota` / auth 首推兜底。 */
  pushQuotaUsageIfChanged(): void {
    for (const tenant of this.tenants.list()) {
      if (this.registry.listTenant(tenant.id).length === 0) continue;
      const usage = this.quotaUsage(tenant.id);
      const fingerprint = relayQuotaUsageFingerprint(usage);
      if (this.lastUsagePush.get(tenant.id) === fingerprint) continue;
      this.lastUsagePush.set(tenant.id, fingerprint);
      this.broadcast(tenant.id, relayQuotaCtl(this.quotaFor(tenant.id), usage.currentNodes, usage));
    }
  }

  broadcast(tenantId: string, msg: RelayCtlMessage): void {
    for (const live of this.registry.listTenant(tenantId)) this.send(live.link, msg);
  }

  sendTo(tenantId: string, nodeId: string, msg: RelayCtlMessage): boolean {
    const live = this.registry.get(tenantId, nodeId);
    if (!live) return false;
    this.send(live.link, msg);
    return true;
  }

  /** 踢租户：先发 `relay.kicked`，再断开该租户全部链路。 */
  kickTenant(tenantId: string, reason: RelayKickReason): void {
    for (const live of this.registry.listTenant(tenantId)) this.kickLink(live, reason);
  }

  /**
   * 重新签发租户令牌后调用：持旧令牌的链路立刻断开。
   * 不这么做，被踢的一方只要连着就永远不复查令牌（reauth 也就没有「踢掉旧会话」的效果）。
   */
  enforceTokenReissue(tenantId: string, tokenHash: string): void {
    for (const live of this.registry.listTenant(tenantId)) {
      if (live.tokenHash === tokenHash) continue;
      this.kickLink(live, 'kicked');
    }
  }

  /** 每租户 `relay.enroll.create` 频率闸。 */
  allowEnrollCreate(tenantId: string): boolean {
    return this.enrollCreates.allow(tenantId);
  }

  /** 随计量刷盘跑：清掉过期 / 用旧了的 enrollment 行，并回收频率闸的空桶。 */
  sweepEnrollments(): void {
    try {
      this.tenants.sweepEnrollments(this.now(), RELAY_ENROLLMENT_USED_RETENTION_MS);
    } catch {
      // 清理失败不该影响转发
    }
    this.enrollCreates.sweep();
  }

  /** 改密（kick 模式）后调用：令牌 epoch 低于门槛的链路全部断开。 */
  enforceMinTokenEpoch(minTokenEpoch: number): void {
    for (const live of this.registry.all()) {
      if (live.tokenEpoch >= minTokenEpoch) continue;
      this.kickLink(live, 'password_rotated');
    }
  }

  disconnectNode(tenantId: string, nodeId: string, reason: RelayKickReason): void {
    const live = this.registry.get(tenantId, nodeId);
    if (live) this.kickLink(live, reason);
    if (reason === 'revoked') {
      this.metering.forgetMember(tenantId, nodeId);
      this.registry.forgetMember(tenantId, nodeId);
    }
  }

  /** ctl 发送是异步排空的，立刻 close 会把 `relay.kicked` 丢掉，所以下一个宏任务再断。 */
  private kickLink(live: RelayLiveNode, reason: RelayKickReason): void {
    this.send(live.link, { t: 'relay.kicked', reason });
    const link = live.link;
    const timer = setTimeout(() => {
      this.closeTimers.delete(timer);
      link.close(`relay-${reason}`);
    }, 0);
    this.closeTimers.add(timer);
  }

  scheduleList(tenantId: string): void {
    if (this.stopped || this.listTimers.has(tenantId)) return;
    const timer = setTimeout(() => {
      this.listTimers.delete(tenantId);
      this.publishList(tenantId);
    }, this.listDebounceMs);
    this.listTimers.set(tenantId, timer);
  }

  publishList(tenantId: string): void {
    if (this.stopped) return;
    const targets = this.registry.listTenant(tenantId);
    if (targets.length === 0) return;
    const bytes = encodeRelayList(this.listDeps, tenantId);
    if (!bytes) return;
    for (const live of targets) this.sendBytes(live.link, bytes);
  }

  send(link: LinkSession, msg: RelayCtlMessage): void {
    try {
      this.sendBytes(link, encodeRelayCtl(msg));
    } catch (err) {
      console.warn(`[relay] failed to encode ctl ${msg.t}: ${String(err)}`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.listTimers.values()) clearTimeout(timer);
    this.listTimers.clear();
    for (const live of this.registry.all()) this.clearHeartbeat(live);
    this.registry.clear();
    for (const timer of this.authTimers.values()) clearTimeout(timer);
    this.authTimers.clear();
    for (const timer of this.closeTimers) clearTimeout(timer);
    this.closeTimers.clear();
    for (const link of [...this.accepted]) link.close('relay-stop');
    this.accepted.clear();
    this.buckets.clear();
    this.enrollCreates.clear();
    await this.ctlQueue.drain();
  }

  private sendBytes(link: LinkSession, bytes: Uint8Array): void {
    try {
      link.ctl.send(bytes);
    } catch {
      // 死链路不该把异常抛回调用方
    }
  }

  private enqueueCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    if (this.stopped || !this.accepted.has(link)) return Promise.resolve();
    if (bytes.byteLength > RELAY_CTL_MAX_BYTES) {
      link.close('protocol_error');
      return Promise.resolve();
    }
    return this.ctlQueue.enqueue(
      link,
      bytes,
      () => this.onCtl(link, bytes),
      () => this.accepted.has(link)
    );
  }

  private async onCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    if (this.stopped || !this.accepted.has(link)) return;
    let msg: RelayCtlMessage;
    try {
      msg = decodeRelayCtl(bytes);
    } catch {
      link.close('protocol_error');
      return;
    }
    const live = this.registry.fromLink(link);
    if (!live) {
      if (msg.t !== 'relay.auth') {
        this.reject(link, 'unauthenticated');
        return;
      }
      await this.handleAuth(link, msg);
      return;
    }
    this.dispatchAuthenticated(live, msg);
  }

  private dispatchAuthenticated(live: RelayLiveNode, msg: RelayCtlMessage): void {
    const tenant = this.tenants.get(live.tenantId);
    if (!tenant) {
      live.link.close('relay-tenant-gone');
      return;
    }
    const minTokenEpoch = this.configStore.ensure(this.now()).minTokenEpoch;
    if (!liveAuthStillValid(live, tenant, minTokenEpoch)) {
      this.kickLink(
        live,
        tenant.kicked || live.tokenHash !== tenant.tokenHash ? 'kicked' : 'password_rotated'
      );
      return;
    }
    switch (msg.t) {
      case 'ping':
        this.send(live.link, { t: 'pong' });
        return;
      case 'pong':
        noteRelayPong(live, this.now());
        return;
      case 'relay.status':
        live.statusBlob = msg.blob;
        live.statusEpoch = msg.epoch;
        this.tenants.patchNode(tenant.id, live.nodeId, { lastSeenAt: this.now() });
        this.scheduleList(tenant.id);
        return;
      case 'relay.keylog.append':
        handleRelayKeyLogAppend(this, live, tenant, msg);
        return;
      case 'relay.keylog.req': {
        const page = pageRelayKeyLog({ keyLog: this.keyLog }, tenant.id, msg.from_seq, msg.limit);
        this.send(live.link, {
          t: 'relay.keylog.res',
          records: page.records,
          ...(page.hasMore ? { has_more: true } : {}),
        });
        return;
      }
      case 'relay.rtc':
        handleRelayRtc(this, live, msg);
        return;
      case 'relay.enroll.create':
        handleRelayEnrollCreate(this, live, tenant, msg);
        return;
      default:
        return;
    }
  }

  private async handleAuth(
    link: LinkSession,
    msg: Extract<RelayCtlMessage, { t: 'relay.auth' }>
  ): Promise<void> {
    const pending = this.pending.get(link);
    this.pending.delete(link);
    this.clearAuthTimer(link);
    await handleRelayAuth(
      {
        tenants: this.tenants,
        keyLog: this.keyLog,
        registry: this.registry,
        configStore: this.configStore,
        now: this.now,
        relayHost: this.relayHost,
        minClientVersion: this.minClientVersion,
        stopped: this.stopped,
        accepted: this.accepted,
        authBarrier: this.authBarrier,
        reject: (target, reason) => this.reject(target, reason),
        send: (target, ctl) => this.send(target, ctl),
        startHeartbeat: (live) => this.startHeartbeat(live),
        notifyQuota: (tenantId) => this.notifyQuota(tenantId),
        scheduleList: (tenantId) => this.scheduleList(tenantId),
        rtcConfig: () => this.rtcConfig(),
      },
      link,
      msg,
      pending
    );
  }

  private async onIncomingStream(link: LinkSession, stream: LinkStream): Promise<void> {
    const live = this.registry.fromLink(link);
    if (!live) {
      stream.reset('unauthenticated');
      return;
    }
    await acceptRelayStream(
      {
        registry: this.registry,
        tenants: this.tenants,
        metering: this.metering,
        quotaFor: (tenantId) => this.quotaFor(tenantId),
        bucketFor: (tenantId) => this.bucketFor(tenantId),
        isStopped: () => this.stopped,
      },
      live,
      stream
    );
  }

  private reject(link: LinkSession, reason: string): void {
    this.pending.delete(link);
    this.clearAuthTimer(link);
    link.close(reason);
  }

  private startHeartbeat(live: RelayLiveNode): void {
    this.clearHeartbeat(live);
    if (this.heartbeatIntervalMs <= 0) return;
    live.heartbeat = setInterval(() => {
      this.beat(live);
    }, this.heartbeatIntervalMs);
  }

  private beat(live: RelayLiveNode): void {
    if (this.registry.fromLink(live.link) !== live) {
      this.clearHeartbeat(live);
      return;
    }
    if (live.awaitingPong) {
      live.misses += 1;
      if (live.misses >= this.heartbeatMissLimit) {
        live.link.close('heartbeat-timeout');
      }
      return;
    }
    live.awaitingPong = true;
    noteRelayPing(live, this.now());
    this.send(live.link, { t: 'ping' });
  }

  private clearHeartbeat(live: RelayLiveNode): void {
    if (live.heartbeat !== null) {
      clearInterval(live.heartbeat);
      live.heartbeat = null;
    }
  }

  private armAuthTimer(link: LinkSession): void {
    this.clearAuthTimer(link);
    const timer = setTimeout(() => {
      this.authTimers.delete(link);
      if (!this.registry.fromLink(link) && this.accepted.has(link)) {
        this.reject(link, 'auth-timeout');
      }
    }, this.authTimeoutMs);
    this.authTimers.set(link, timer);
  }

  private clearAuthTimer(link: LinkSession): void {
    const timer = this.authTimers.get(link);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.authTimers.delete(link);
    }
  }

  private onLinkClosed(link: LinkSession): void {
    this.pending.delete(link);
    this.clearAuthTimer(link);
    this.accepted.delete(link);
    const live = this.registry.removeLink(link);
    if (!live) return;
    this.clearHeartbeat(live);
    if (this.stopped) return;
    this.tenants.patchNode(live.tenantId, live.nodeId, { lastSeenAt: this.now() });
    this.scheduleList(live.tenantId);
  }
}
