import os from 'node:os';
import {
  bytesEqual,
  computeRecordHash,
  decodeCertificate,
  decodeKeyLogRecord,
  encodeBase64url,
  hubHostFromUrl,
  nodeIdToHex,
  randomBytes,
  uplinkAuthMessage,
  verifyEd25519,
} from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import {
  HUB_NOT_WRITER,
  type HubAdvertisement,
  type HubEndpointInfo,
  type HubMode,
  type HubNotWriterError,
  UPLINK_CTL_MAX_HUBS,
} from '@tmex/shared/uplink';
import { MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
import { parseJson, projectNode, upsertById } from '../mesh/node-list-projection';
import { pumpLink } from '../mesh/stream-pump';
import { trimKeyLogPageToByteLimit } from './key-log-page';
import { patchNode } from './node-persistence';
import type { NodeRegistry } from './node-registry';
import {
  HUB_AUTH_TIMEOUT_MS,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_HEARTBEAT_MISS_LIMIT,
  HUB_RTC_MAX_SESSIONS,
  HUB_RTC_TTL_MS,
  type HubKeyLogAppendSuccess,
  type HubKeyLogSource,
  type HubRuntimeConfig,
} from './types';
import {
  KEY_LOG_PAGE_DEFAULT_LIMIT,
  KEY_LOG_PAGE_MAX_LIMIT,
  type NodeListMessage,
  type RtcSignalMessage,
  UPLINK_CTL_MAX_BYTES,
  type UplinkCtlMessage,
  b64urlToBytes,
  bytesToB64url,
  decodeUplinkCtl,
  encodeUplinkCtl,
  seqToWire,
} from './uplink-protocol';
import {
  HUB_KEY_LOG_REQ_IDLE_TTL_MS,
  HUB_KEY_LOG_REQ_STATE_MAX,
  IdleLruMap,
  KeyLogReqLimiter,
  WindowedLogBudget,
} from './uplink-rate-limit';

export {
  HUB_KEY_LOG_REQ_BURST,
  HUB_KEY_LOG_REQ_IDLE_TTL_MS,
  HUB_KEY_LOG_REQ_OVERFLOW_MAX_NODES,
  HUB_KEY_LOG_REQ_OVERFLOW_MAX_USERS,
  HUB_KEY_LOG_REQ_RATE_PER_MIN,
  HUB_KEY_LOG_REQ_RETRY_AFTER_MS,
  HUB_KEY_LOG_REQ_STATE_MAX,
  KeyLogReqLimiter,
} from './uplink-rate-limit';

export type RegisterRtcSessionInput = {
  userId: string;
  browserSessionId: string;
  fromNodeId: string;
  toNodeId: string;
  ttlMs?: number;
};

export type RtcSessionRegistration = {
  rtcSession: string;
  userId: string;
  browserSessionId: string;
  fromNodeId: string;
  toNodeId: string;
  expiresAt: number;
};

export type UplinkServerOptions = {
  db: AuthDb;
  userStore: UserStore;
  keyLogSource: HubKeyLogSource;
  registry: NodeRegistry;
  config: HubRuntimeConfig;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
  rtcMaxSessions?: number;
  keyLogReqStateMax?: number;
  keyLogReqIdleTtlMs?: number;
  meshHubs?: MeshHubStore;
};

type PendingAuth = {
  nonce: Uint8Array;
};

type CtlQueueState = {
  depth: number;
  bytes: number;
  tail: Promise<void>;
};

// 按消息数与累计字节双重上限：合法突发（并发 rtc.signal + key.log.req）远超 8 条，但都是小帧
export const HUB_CTL_QUEUE_MAX = 256;
export const HUB_CTL_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_STOP_DRAIN_TIMEOUT_MS = 5_000;

type LiveConnection = {
  nodeId: string;
  userId: string;
  link: LinkSession;
  generation: number;
  misses: number;
  awaitingPong: boolean;
  heartbeat: ReturnType<typeof setInterval> | null;
};

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const HUB_KEY_LOG_REQ_LOG_INTERVAL_MS = 10_000;
export const HUB_SPLIT_BRAIN_LOG_INTERVAL_MS = 60_000;
export const HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS = 10_000;
export const HUB_UPLINK_AUTH_REJECT_LOG_GLOBAL_MAX = 20;
export const HUB_UPLINK_AUTH_REJECT_LOG_ADDR_MAX = 20;
const AUTH_REJECT_ADDR_BUDGET_MAX = 256;
const HUB_NODE_ID_HEX = /^[0-9a-f]{32}$/i;

function sanitizeLogField(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 10) {
      out += '\\n';
    } else if (code === 13) {
      out += '\\r';
    } else if (code === 9) {
      out += '\\t';
    } else if (code < 32 || code === 127) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += value[i];
    }
  }
  return out;
}

export class UplinkServer {
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly keyLogSource: HubKeyLogSource;
  readonly registry: NodeRegistry;
  readonly meshHubs: MeshHubStore;
  private readonly config: HubRuntimeConfig;
  private currentMode: HubMode;
  private readonly hubPriority: number;
  private readonly hubWriterEpoch: number;
  private lastSplitBrainLogAt: number | null = null;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMissLimit: number;
  private readonly authTimeoutMs: number;
  private readonly rtcMaxSessions: number;
  private readonly pending = new WeakMap<LinkSession, PendingAuth>();
  private readonly live = new Map<LinkSession, LiveConnection>();
  private readonly accepted = new Set<LinkSession>();
  private readonly authTimers = new Map<LinkSession, ReturnType<typeof setTimeout>>();
  private readonly ctlQueues = new WeakMap<LinkSession, CtlQueueState>();
  private readonly rtcSessions = new Map<string, RtcSessionRegistration>();
  private listVersion = 0;
  private readonly lastNodeListFp = new Map<string, string>();
  private readonly lastNodeListSent = new Map<string, Uint8Array>();
  private readonly nodeListLatestGen = new Map<string, number>();
  private readonly nodeListInflight = new Map<string, Promise<'sent' | 'unchanged' | 'failed'>>();
  private stopped = false;
  private readonly inflightCtl = new Set<Promise<void>>();
  private readonly keyLogReqLimiter: KeyLogReqLimiter;
  private readonly keyLogReqLogs: IdleLruMap<{ lastAt: number; suppressed: number }>;
  private readonly authRejectLogs: IdleLruMap<{ lastAt: number; suppressed: number }>;
  private readonly authRejectGlobal = new WindowedLogBudget(
    HUB_UPLINK_AUTH_REJECT_LOG_GLOBAL_MAX,
    HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS
  );
  private readonly authRejectByAddr = new Map<string, WindowedLogBudget>();
  private readonly linkRemoteAddress = new WeakMap<LinkSession, string>();

  constructor(opts: UplinkServerOptions) {
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.keyLogSource = opts.keyLogSource;
    this.registry = opts.registry;
    this.meshHubs = opts.meshHubs ?? new MeshHubStore(opts.db);
    this.config = opts.config;
    this.currentMode = opts.config.mode ?? 'active';
    this.hubWriterEpoch = opts.config.writerEpoch ?? 1;
    this.hubPriority = opts.config.priority ?? (this.currentMode === 'standby' ? 200 : 100);
    this.now = opts.now ?? Date.now;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS;
    this.heartbeatMissLimit = opts.heartbeatMissLimit ?? HUB_HEARTBEAT_MISS_LIMIT;
    this.authTimeoutMs = opts.authTimeoutMs ?? HUB_AUTH_TIMEOUT_MS;
    this.rtcMaxSessions = opts.rtcMaxSessions ?? HUB_RTC_MAX_SESSIONS;
    this.keyLogReqLimiter = new KeyLogReqLimiter({
      max: opts.keyLogReqStateMax ?? HUB_KEY_LOG_REQ_STATE_MAX,
      ttlMs: opts.keyLogReqIdleTtlMs ?? HUB_KEY_LOG_REQ_IDLE_TTL_MS,
    });
    this.keyLogReqLogs = new IdleLruMap(
      opts.keyLogReqStateMax ?? HUB_KEY_LOG_REQ_STATE_MAX,
      opts.keyLogReqIdleTtlMs ?? HUB_KEY_LOG_REQ_IDLE_TTL_MS
    );
    this.authRejectLogs = new IdleLruMap(
      opts.keyLogReqStateMax ?? HUB_KEY_LOG_REQ_STATE_MAX,
      opts.keyLogReqIdleTtlMs ?? HUB_KEY_LOG_REQ_IDLE_TTL_MS
    );
    if (opts.config.nodeId) {
      this.userStore.upsertHubMeta({
        nodeId: opts.config.nodeId,
        publicUrl: opts.config.publicUrl,
        now: this.now(),
      });
    }
    this.upsertSelfHub();
  }

  mode(): HubMode {
    return this.currentMode;
  }

  writerEpoch(): number {
    return this.hubWriterEpoch;
  }

  hubNodeId(): string | undefined {
    const id = this.config.hubNodeId ?? this.config.nodeId;
    return id && HUB_NODE_ID_HEX.test(id) ? id.toLowerCase() : undefined;
  }

  setMode(mode: HubMode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    this.upsertSelfHub();
    this.broadcastAllNodeLists();
  }

  notWriterError(): HubNotWriterError {
    const hubs = this.meshHubs.list();
    const writerId = pickWriterHub(hubs);
    const writer = writerId ? this.meshHubs.get(writerId) : null;
    return {
      code: HUB_NOT_WRITER,
      writerHubId: writerId,
      writerPublicUrl: writer?.publicUrl ?? null,
      writerEpoch: writer?.writerEpoch ?? null,
    };
  }

  broadcastAllNodeLists(): void {
    const seen = new Set<string>();
    for (const entry of this.registry.listAuthenticated()) {
      if (seen.has(entry.userId)) continue;
      seen.add(entry.userId);
      void this.broadcastNodeList(entry.userId);
    }
  }

  accept(link: LinkSession, opts?: { remoteAddress?: string }): void {
    if (this.stopped) {
      link.close('hub-stop');
      return;
    }
    const nonce = randomBytes(32);
    this.accepted.add(link);
    if (opts?.remoteAddress) {
      this.linkRemoteAddress.set(link, opts.remoteAddress);
    }
    this.pending.set(link, { nonce });
    this.armAuthTimer(link);
    this.send(link, { t: 'auth.challenge', nonce: encodeBase64url(nonce) });
    link.ctl.onMessage((bytes) => this.enqueueCtl(link, bytes));
    link.onStream((stream) => {
      void this.onIncomingStream(link, stream);
    });
    void link.closed.then(() => {
      this.onLinkClosed(link);
    });
  }

  registerRtcSession(input: RegisterRtcSessionInput): string | null {
    this.sweepRtcSessions();
    if (this.rtcSessions.size >= this.rtcMaxSessions) {
      return null;
    }
    if (!this.rtcNodesOwnedBy(input.userId, input.fromNodeId, input.toNodeId)) {
      return null;
    }
    const rtcSession = encodeBase64url(randomBytes(16));
    const ttlMs = input.ttlMs ?? HUB_RTC_TTL_MS;
    this.rtcSessions.set(rtcSession, {
      rtcSession,
      userId: input.userId,
      browserSessionId: input.browserSessionId,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      expiresAt: this.now() + ttlMs,
    });
    return rtcSession;
  }

  unregisterRtcSession(rtcSession: string): void {
    this.rtcSessions.delete(rtcSession);
  }

  ensureDcSession(userId: string, nodeA: string, nodeB: string): boolean {
    const a = nodeA.toLowerCase();
    const b = nodeB.toLowerCase();
    if (!a || !b || a === b) return false;
    if (!this.rtcNodesOwnedBy(userId, a, b)) return false;
    this.sweepRtcSessions();
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const rtcSession = `dc:${lo}:${hi}`;
    const existing = this.rtcSessions.get(rtcSession);
    if (existing) {
      existing.expiresAt = this.now() + HUB_RTC_TTL_MS;
      return true;
    }
    if (this.rtcSessions.size >= this.rtcMaxSessions) return false;
    this.rtcSessions.set(rtcSession, {
      rtcSession,
      userId,
      browserSessionId: '',
      fromNodeId: lo,
      toNodeId: hi,
      expiresAt: this.now() + HUB_RTC_TTL_MS,
    });
    return true;
  }

  sendTo(nodeId: string, msg: UplinkCtlMessage): boolean {
    const entry = this.registry.get(nodeId);
    if (!entry?.authenticated) return false;
    this.send(entry.link, msg);
    return true;
  }

  async broadcastNodeList(userId: string): Promise<'sent' | 'unchanged' | 'failed'> {
    if (this.stopped) return 'failed';
    this.nodeListLatestGen.set(userId, (this.nodeListLatestGen.get(userId) ?? 0) + 1);
    const existing = this.nodeListInflight.get(userId);
    if (existing) return existing;
    const run = this.pumpNodeListBroadcast(userId);
    this.nodeListInflight.set(userId, run);
    return run;
  }

  private async pumpNodeListBroadcast(userId: string): Promise<'sent' | 'unchanged' | 'failed'> {
    try {
      let result: 'sent' | 'unchanged' | 'failed' = 'unchanged';
      while (!this.stopped) {
        const gen = this.nodeListLatestGen.get(userId) ?? 0;
        result = await this.publishNodeList(userId, gen);
        if (this.stopped) {
          this.nodeListInflight.delete(userId);
          return 'failed';
        }
        // 必须与 gen 比较同一同步段内摘掉 inflight，await 后再删会丢掉其间到达的 trigger
        if (gen === (this.nodeListLatestGen.get(userId) ?? 0)) {
          this.nodeListInflight.delete(userId);
          return result;
        }
      }
      this.nodeListInflight.delete(userId);
      return 'failed';
    } catch (err) {
      this.nodeListInflight.delete(userId);
      throw err;
    }
  }

  private async publishNodeList(
    userId: string,
    gen: number
  ): Promise<'sent' | 'unchanged' | 'failed'> {
    if (this.registry.listForBroadcast(userId).length === 0) {
      if (gen !== (this.nodeListLatestGen.get(userId) ?? 0)) return 'unchanged';
      this.lastNodeListFp.delete(userId);
      this.lastNodeListSent.delete(userId);
      return 'unchanged';
    }
    try {
      const msg = await this.buildNodeList(userId);
      if (this.stopped) return 'failed';
      if (gen !== (this.nodeListLatestGen.get(userId) ?? 0)) return 'unchanged';
      const fingerprint = nodeListFingerprint(msg);
      const prev = this.lastNodeListFp.get(userId);
      if (prev === fingerprint) return 'unchanged';
      this.listVersion += 1;
      msg.version = this.listVersion;
      const bytes = encodeUplinkCtl(msg);
      this.lastNodeListFp.set(userId, fingerprint);
      this.lastNodeListSent.set(userId, bytes);
      for (const entry of this.registry.listForBroadcast(userId)) {
        this.sendBytes(entry.link, bytes);
      }
      return 'sent';
    } catch {
      return 'failed';
    }
  }

  disconnect(nodeId: string, reason = 'disconnected'): boolean {
    const entry = this.registry.get(nodeId);
    if (!entry) return false;
    entry.link.close(reason);
    return true;
  }

  async applyAppendEffects(userId: string, result: HubKeyLogAppendSuccess): Promise<void> {
    if (result.record.type === 'rotate-root' || result.record.type === 'reset-root') {
      this.userStore.invalidateUnusedEnrollmentTokens(userId, this.now());
    }
    for (const effect of result.effects) {
      if (effect.type === 'revokeSessionsVia') {
        this.evictRevokedNode(nodeIdToHex(effect.nodeId));
      }
    }
    for (const entry of this.registry.listForBroadcast(userId)) {
      if (this.certIsRevoked(entry.nodeId)) {
        this.evictRevokedNode(entry.nodeId);
      }
    }
    await this.broadcastNodeList(userId);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const links = [...this.accepted];
    for (const live of this.live.values()) {
      this.clearHeartbeat(live);
    }
    this.live.clear();
    for (const link of links) {
      this.clearAuthTimer(link);
      link.close('hub-stop');
    }
    this.accepted.clear();
    this.authTimers.clear();
    this.rtcSessions.clear();
    this.lastNodeListFp.clear();
    this.lastNodeListSent.clear();
    this.keyLogReqLimiter.clear();
    this.keyLogReqLogs.clear();
    this.authRejectLogs.clear();
    this.authRejectGlobal.clear();
    this.authRejectByAddr.clear();
    this.registry.closeAll('hub-stop');
    await this.drainInflight();
  }

  private trackCtl(work: Promise<void>): void {
    this.inflightCtl.add(work);
    void work.finally(() => {
      this.inflightCtl.delete(work);
    });
  }

  private async drainInflight(): Promise<void> {
    const pending = [...this.inflightCtl];
    if (pending.length === 0) return;
    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, HUB_STOP_DRAIN_TIMEOUT_MS);
      void Promise.allSettled(pending).then(() => {
        if (!timedOut) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    if (timedOut) {
      console.warn('[hub] uplink stop drain timed out; continuing');
    }
  }

  get keyLogReqBucketCount(): number {
    return this.keyLogReqLimiter.primarySize;
  }

  private send(link: LinkSession, msg: UplinkCtlMessage): void {
    this.sendBytes(link, encodeUplinkCtl(msg));
  }

  private sendBytes(link: LinkSession, bytes: Uint8Array): void {
    try {
      link.ctl.send(bytes);
    } catch {
      // a dead uplink must never throw out of persist/ack
    }
  }

  private enqueueCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    if (this.stopped || !this.accepted.has(link)) return Promise.resolve();
    if (bytes.byteLength > UPLINK_CTL_MAX_BYTES) {
      link.close('protocol_error');
      return Promise.resolve();
    }
    let q = this.ctlQueues.get(link);
    if (!q) {
      q = { depth: 0, bytes: 0, tail: Promise.resolve() };
      this.ctlQueues.set(link, q);
    }
    if (q.depth >= HUB_CTL_QUEUE_MAX || q.bytes + bytes.byteLength > HUB_CTL_QUEUE_MAX_BYTES) {
      link.close('ctl-overflow');
      return Promise.resolve();
    }
    q.depth += 1;
    q.bytes += bytes.byteLength;
    const run = q.tail.catch(() => undefined).then(() => this.onCtl(link, bytes));
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.trackCtl(settled);
    q.tail = run
      .catch(() => {
        if (this.accepted.has(link)) {
          link.close('ctl-error');
        }
      })
      .finally(() => {
        q.depth = Math.max(0, q.depth - 1);
        q.bytes = Math.max(0, q.bytes - bytes.byteLength);
      });
    return settled;
  }

  private async onCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    if (this.stopped || !this.accepted.has(link)) return;
    let msg: UplinkCtlMessage;
    try {
      msg = decodeUplinkCtl(bytes);
    } catch {
      link.close('protocol_error');
      return;
    }
    const live = this.live.get(link);
    if (!live) {
      if (msg.t !== 'auth.response') {
        this.rejectAuth(link, undefined, 'unauthenticated', 'unauthenticated');
        return;
      }
      await this.handleAuthResponse(link, msg.node_id, msg.sig);
      return;
    }
    if (!this.assertLiveCert(live)) return;
    this.registry.touch(live.nodeId, this.now());
    switch (msg.t) {
      case 'ping':
        this.send(link, { t: 'pong' });
        return;
      case 'pong':
        if (live.awaitingPong) {
          live.awaitingPong = false;
          live.misses = 0;
        }
        return;
      case 'node.status':
        await this.handleNodeStatus(live, msg);
        return;
      case 'key.log.req':
        await this.handleKeyLogReq(live, msg);
        return;
      case 'key.log.append':
        await this.handleKeyLogAppend(live, msg.bytes, msg.sig, msg.id);
        return;
      case 'rtc.signal':
        this.handleRtcSignal(live, msg);
        return;
      case 'key.log.res':
        link.close('protocol_error');
        return;
      default:
        return;
    }
  }

  private async handleAuthResponse(
    link: LinkSession,
    nodeId: string,
    sigB64: string
  ): Promise<void> {
    const pending = this.pending.get(link);
    this.pending.delete(link);
    this.clearAuthTimer(link);
    if (!pending) {
      this.rejectAuth(link, nodeId, 'timeout', 'auth-timeout');
      return;
    }
    const cert = this.userStore.getCert(nodeId);
    if (!cert) {
      this.rejectAuth(link, nodeId, 'cert_not_admitted', 'unknown-cert');
      return;
    }
    if (cert.revokedLogSeq !== null) {
      this.rejectAuth(link, nodeId, 'revoked', 'revoked');
      return;
    }
    const nodeRow = this.userStore.getNode(nodeId);
    if (nodeRow?.status === 'revoked') {
      this.rejectAuth(link, nodeId, 'revoked', 'revoked');
      return;
    }
    let edPk: Uint8Array;
    try {
      edPk = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      this.rejectAuth(link, nodeId, 'bad_cert', 'bad-cert');
      return;
    }
    let sig: Uint8Array;
    try {
      sig = b64urlToBytes(sigB64, 64);
    } catch {
      this.rejectAuth(link, nodeId, 'bad_sig', 'bad-sig');
      return;
    }
    if (
      !verifyEd25519(
        sig,
        uplinkAuthMessage(pending.nonce, hubHostFromUrl(this.config.publicUrl)),
        edPk
      )
    ) {
      this.rejectAuth(link, nodeId, 'bad_sig', 'unauthorized');
      return;
    }
    const userId = cert.userId;
    const name = nodeRow?.name ?? nodeId;
    const registered = this.registry.put({
      nodeId,
      userId,
      link,
      meta: this.registry.emptyMeta(name),
      lastSeen: this.now(),
      authenticated: true,
    });
    const live: LiveConnection = {
      nodeId,
      userId,
      link,
      generation: registered.generation,
      misses: 0,
      awaitingPong: false,
      heartbeat: null,
    };
    this.live.set(link, live);
    this.startHeartbeat(live);
    this.send(link, { t: 'auth.ok' });
    if ((await this.broadcastNodeList(userId)) === 'unchanged') {
      const cached = this.lastNodeListSent.get(userId);
      if (cached) this.sendBytes(link, cached);
    }
  }

  private async handleNodeStatus(
    live: LiveConnection,
    msg: Extract<UplinkCtlMessage, { t: 'node.status' }>
  ): Promise<void> {
    if (this.stopped || !this.assertLiveCert(live)) return;
    const now = this.now();
    const inventoryJson = stringifyJson(msg.inventory);
    const endpointsJson = stringifyJson(msg.endpoints);
    try {
      const existing = this.userStore.getNode(live.nodeId);
      if (!existing) {
        this.userStore.createNode({
          id: live.nodeId,
          userId: live.userId,
          name:
            this.config.nodeId && live.nodeId === this.config.nodeId
              ? this.nodeDisplayName(live.nodeId)
              : live.nodeId,
          status: 'enrolled',
          lastSeenAt: now,
          version: msg.version,
          directCapable: msg.direct_capable,
          inventoryJson,
          inventoryVersion: 1,
          endpointsJson,
          now,
        });
      } else {
        patchNode(this.db, live.nodeId, {
          lastSeenAt: now,
          version: msg.version,
          directCapable: msg.direct_capable,
          inventoryJson,
          inventoryVersion: existing.inventoryVersion + 1,
          endpointsJson,
        });
      }
      this.registry.updateMeta(
        live.nodeId,
        {
          version: msg.version,
          tmux: msg.tmux,
          directCapable: msg.direct_capable,
          inventory: msg.inventory,
          endpoints: msg.endpoints,
        },
        now
      );
      if (msg.hub) this.ingestHubAdvertisement(live, msg.hub);
      await this.broadcastNodeList(live.userId);
    } catch {
      if (!this.stopped) throw new Error('node_status_failed');
    }
  }

  private async handleKeyLogReq(
    live: LiveConnection,
    msg: Extract<UplinkCtlMessage, { t: 'key.log.req' }>
  ): Promise<void> {
    const now = this.now();
    const fromSeq = BigInt(msg.from_seq);
    if (!this.keyLogReqLimiter.take(live.nodeId, live.userId, now)) {
      this.warnKeyLogReq(live.nodeId, fromSeq, 0, true);
      this.send(live.link, {
        t: 'key.log.res',
        records: [],
        error: 'rate_limited',
        retry_after_ms: this.keyLogReqLimiter.retryAfterMs,
        ...(msg.id ? { id: msg.id } : {}),
      });
      return;
    }
    const requested = msg.limit ?? KEY_LOG_PAGE_DEFAULT_LIMIT;
    const limit = Math.min(KEY_LOG_PAGE_MAX_LIMIT, Math.max(1, requested));
    const fetched = await this.keyLogSource.list(live.userId, fromSeq, limit + 1);
    const hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;
    const trimmed = trimKeyLogPageToByteLimit(page, hasMore, msg.id ? { id: msg.id } : undefined);
    this.warnKeyLogReq(live.nodeId, fromSeq, trimmed.records.length, false);
    this.send(live.link, {
      t: 'key.log.res',
      records: trimmed.records,
      has_more: trimmed.hasMore,
      ...(msg.id ? { id: msg.id } : {}),
    });
  }

  private rejectAuth(
    link: LinkSession,
    nodeId: string | undefined,
    reason: string,
    closeReason: string
  ): void {
    this.logAuthRejected(nodeId, reason, this.linkRemoteAddress.get(link));
    link.close(closeReason);
  }

  private logAuthRejected(
    nodeId: string | undefined,
    reason: string,
    remoteAddress?: string
  ): void {
    const now = this.now();
    const safeNode = sanitizeLogField(nodeId ?? '-');
    const safeReason = sanitizeLogField(reason);
    const key = `${safeNode}|${safeReason}`;
    const budgets = [this.authRejectGlobal];
    if (remoteAddress) {
      budgets.push(this.authRejectAddrBudget(remoteAddress));
    }
    const prev = this.authRejectLogs.get(key, now);
    const keyBlocked = Boolean(prev && now - prev.lastAt < HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS);
    const budgetBlocked = budgets.some((budget) => !budget.wouldAllow(now));
    if (keyBlocked || budgetBlocked) {
      if (keyBlocked && prev) {
        prev.suppressed += 1;
      }
      if (budgetBlocked) {
        for (const budget of budgets) {
          if (!budget.wouldAllow(now)) budget.suppress();
        }
      }
      return;
    }
    let suppressed = prev?.suppressed ?? 0;
    for (const budget of budgets) {
      suppressed += budget.take(now);
    }
    const extra = suppressed > 0 ? ` suppressed=${suppressed}` : '';
    console.warn(`[hub][uplink] auth rejected node=${safeNode} reason=${safeReason}${extra}`);
    this.authRejectLogs.set(key, { lastAt: now, suppressed: 0 }, now);
  }

  private authRejectAddrBudget(remoteAddress: string): WindowedLogBudget {
    const key = sanitizeLogField(remoteAddress);
    let budget = this.authRejectByAddr.get(key);
    if (!budget) {
      while (this.authRejectByAddr.size >= AUTH_REJECT_ADDR_BUDGET_MAX) {
        const oldest = this.authRejectByAddr.keys().next().value;
        if (oldest === undefined) break;
        this.authRejectByAddr.delete(oldest);
      }
      budget = new WindowedLogBudget(
        HUB_UPLINK_AUTH_REJECT_LOG_ADDR_MAX,
        HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS
      );
      this.authRejectByAddr.set(key, budget);
    }
    return budget;
  }

  private warnKeyLogReq(nodeId: string, fromSeq: bigint, records: number, limited: boolean): void {
    const now = this.now();
    const prev = this.keyLogReqLogs.get(nodeId, now);
    if (prev && now - prev.lastAt < HUB_KEY_LOG_REQ_LOG_INTERVAL_MS) {
      prev.suppressed += 1;
      return;
    }
    const suppressed = prev?.suppressed ?? 0;
    const extra = [suppressed > 0 ? `suppressed=${suppressed}` : '', limited ? 'limited=1' : '']
      .filter(Boolean)
      .join(' ');
    console.warn(
      `[hub] key.log.req node=${nodeId} from_seq=${fromSeq.toString()} records=${records}${extra ? ` ${extra}` : ''}`
    );
    this.keyLogReqLogs.set(nodeId, { lastAt: now, suppressed: 0 }, now);
  }

  private async handleKeyLogAppend(
    live: LiveConnection,
    bytesB64: string,
    sigB64: string,
    id?: string
  ): Promise<void> {
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = b64urlToBytes(bytesB64);
      sig = b64urlToBytes(sigB64, 64);
    } catch {
      live.link.close('protocol_error');
      return;
    }
    const result = await this.keyLogSource.append(live.userId, { bytes, sig });
    if (result.ok) {
      if (id) {
        this.send(live.link, { t: 'key.log.ack', id, ok: true, seq: seqToWire(result.seq) });
      }
      await this.runAppendEffects(live.userId, result);
      return;
    }
    const replayed = await this.identicalHeadRecord(live.userId, bytes, sig);
    if (replayed) {
      if (id) {
        this.send(live.link, { t: 'key.log.ack', id, ok: true, seq: seqToWire(replayed.seq) });
      }
      await this.runAppendEffects(
        live.userId,
        this.replayedAppendSuccess(bytes, sig, replayed.seq)
      );
      return;
    }
    if (id) {
      this.send(live.link, { t: 'key.log.ack', id, ok: false, error: result.error });
    }
  }

  private replayedAppendSuccess(
    bytes: Uint8Array,
    sig: Uint8Array,
    seq: bigint
  ): HubKeyLogAppendSuccess {
    const record = decodeKeyLogRecord(bytes);
    return {
      ok: true,
      seq,
      hash: computeRecordHash(bytes, sig),
      effects: [],
      record: { type: record.type, payload: record.payload },
    };
  }

  private async runAppendEffects(userId: string, result: HubKeyLogAppendSuccess): Promise<void> {
    try {
      await this.applyAppendEffects(userId, result);
    } catch {
      // effects are retried on identical-record replay
    }
  }

  private async identicalHeadRecord(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): Promise<{ seq: bigint } | null> {
    let seq: bigint;
    try {
      seq = decodeKeyLogRecord(bytes).seq;
    } catch {
      return null;
    }
    const listed = await this.keyLogSource.list(userId, seq);
    const existing = listed.find((row) => row.seq === seq);
    if (!existing) return null;
    if (!bytesEqual(existing.bytes, bytes) || !bytesEqual(existing.sig, sig)) return null;
    return { seq };
  }

  private handleRtcSignal(live: LiveConnection, msg: RtcSignalMessage): void {
    this.sweepRtcSessions();
    const dc = parseDcPeerSession(msg.rtcSession);
    if (dc) {
      this.forwardDcSignal(live, msg, dc);
      return;
    }
    const reg = this.rtcSessions.get(msg.rtcSession);
    if (!reg) return;
    if (reg.userId !== live.userId) return;
    if (!this.rtcNodesOwnedBy(reg.userId, reg.fromNodeId, reg.toNodeId)) {
      this.rtcSessions.delete(msg.rtcSession);
      return;
    }
    if (msg.from === 'browser') {
      if (live.nodeId !== reg.fromNodeId || msg.to !== reg.toNodeId) return;
    } else if (msg.from === 'node') {
      if (live.nodeId !== reg.toNodeId || msg.to !== reg.fromNodeId) return;
    } else {
      return;
    }
    const target = this.registry.get(msg.to);
    if (!target?.authenticated || target.userId !== reg.userId) return;
    this.send(target.link, msg);
  }

  private forwardDcSignal(
    live: LiveConnection,
    msg: RtcSignalMessage,
    dc: { a: string; b: string }
  ): void {
    if (!this.rtcNodesOwnedBy(live.userId, dc.a, dc.b)) return;
    if (live.nodeId !== dc.a && live.nodeId !== dc.b) return;
    const other = live.nodeId === dc.a ? dc.b : dc.a;
    if (msg.to !== other) return;
    if (msg.from !== 'node') return;
    this.ensureDcSession(live.userId, dc.a, dc.b);
    const target = this.registry.get(msg.to);
    if (!target?.authenticated || target.userId !== live.userId) return;
    this.send(target.link, msg);
  }

  private async onIncomingStream(link: LinkSession, stream: LinkStream): Promise<void> {
    const live = this.live.get(link);
    if (!live) {
      stream.reset('unauthenticated');
      return;
    }
    if (!this.assertLiveCert(live)) {
      stream.reset('revoked');
      return;
    }
    const open = parseRelayOpen(stream.openPayload);
    if (!open) {
      stream.reset('invalid-relay');
      return;
    }
    const targetCert = this.userStore.getCert(open.to);
    if (!targetCert || targetCert.revokedLogSeq !== null) {
      stream.reset(targetCert ? 'revoked' : 'unknown-cert');
      return;
    }
    if (targetCert.userId !== live.userId) {
      stream.reset('cross-user');
      return;
    }
    const targetEntry = this.registry.get(open.to);
    if (!targetEntry?.authenticated) {
      stream.reset('offline');
      return;
    }
    const outboundPayload = textEncoder.encode(JSON.stringify({ ...open.raw, from: live.nodeId }));
    let outbound: LinkStream;
    try {
      outbound = await targetEntry.link.openStream(outboundPayload);
    } catch {
      stream.reset('open-failed');
      return;
    }
    pumpRelay(stream, outbound);
  }

  private startHeartbeat(live: LiveConnection): void {
    this.clearHeartbeat(live);
    live.heartbeat = setInterval(() => {
      this.beat(live);
    }, this.heartbeatIntervalMs);
  }

  private beat(live: LiveConnection): void {
    if (this.live.get(live.link) !== live) {
      this.clearHeartbeat(live);
      return;
    }
    if (live.awaitingPong) {
      live.misses += 1;
    }
    if (live.misses >= this.heartbeatMissLimit) {
      live.link.close('heartbeat-timeout');
      return;
    }
    live.awaitingPong = true;
    this.send(live.link, { t: 'ping' });
  }

  private clearHeartbeat(live: LiveConnection): void {
    if (live.heartbeat !== null) {
      clearInterval(live.heartbeat);
      live.heartbeat = null;
    }
  }

  private armAuthTimer(link: LinkSession): void {
    this.clearAuthTimer(link);
    const timer = setTimeout(() => {
      this.authTimers.delete(link);
      if (!this.live.has(link) && this.accepted.has(link)) {
        this.pending.delete(link);
        this.rejectAuth(link, undefined, 'timeout', 'auth-timeout');
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
    const live = this.live.get(link);
    this.live.delete(link);
    if (!live) return;
    this.clearHeartbeat(live);
    this.dropRtcForNode(live.nodeId);
    const removed = this.registry.remove(live.nodeId, live.generation);
    if (!removed || this.stopped) return;
    const now = this.now();
    patchNode(this.db, live.nodeId, { lastSeenAt: now });
    const ownId = this.hubNodeId();
    if (live.nodeId !== ownId) {
      const rec = this.meshHubs.get(live.nodeId);
      if (rec) {
        this.meshHubs.upsert({ ...rec, online: false, lastSeenAt: now }, now);
      }
    }
    void this.broadcastNodeList(live.userId);
  }

  private assertLiveCert(live: LiveConnection): boolean {
    if (this.certIsRevoked(live.nodeId)) {
      this.evictRevokedNode(live.nodeId);
      return false;
    }
    return true;
  }

  private certIsRevoked(nodeId: string): boolean {
    const cert = this.userStore.getCert(nodeId);
    return !cert || cert.revokedLogSeq !== null;
  }

  private evictRevokedNode(nodeId: string): void {
    patchNode(this.db, nodeId, { status: 'revoked' });
    this.keyLogReqLimiter.delete(nodeId);
    this.keyLogReqLogs.delete(nodeId);
    this.dropRtcForNode(nodeId);
    const entry = this.registry.get(nodeId);
    if (!entry) return;
    const live = this.live.get(entry.link);
    if (live) {
      this.clearHeartbeat(live);
      this.live.delete(entry.link);
    }
    this.registry.remove(nodeId, entry.generation);
    entry.link.close('revoked');
  }

  private dropRtcForNode(nodeId: string): void {
    for (const [id, reg] of this.rtcSessions) {
      if (reg.fromNodeId === nodeId || reg.toNodeId === nodeId) {
        this.rtcSessions.delete(id);
      }
    }
  }

  private sweepRtcSessions(): void {
    const now = this.now();
    for (const [id, reg] of this.rtcSessions) {
      if (reg.expiresAt <= now) {
        this.rtcSessions.delete(id);
      }
    }
  }

  private rtcNodesOwnedBy(userId: string, fromNodeId: string, toNodeId: string): boolean {
    const fromCert = this.userStore.getCert(fromNodeId);
    const toCert = this.userStore.getCert(toNodeId);
    if (!fromCert || !toCert) return false;
    if (fromCert.revokedLogSeq !== null || toCert.revokedLogSeq !== null) return false;
    return fromCert.userId === userId && toCert.userId === userId;
  }

  private async buildNodeList(userId: string): Promise<NodeListMessage> {
    const version = Math.max(1, this.listVersion);
    const head = await this.keyLogSource.head(userId);
    const online = new Map(
      this.registry.listForBroadcast(userId).map((n) => [n.nodeId, n] as const)
    );
    const nodes = this.userStore
      .listNodes()
      .filter((n) => n.userId === userId && n.status === 'enrolled')
      .map((n) => {
        const live = online.get(n.id);
        return projectNode(
          n.id,
          n.name,
          Boolean(live),
          {
            endpoints: parseJson(n.endpointsJson, []),
            inventory: parseJson(n.inventoryJson, {}),
            directCapable: n.directCapable,
            version: n.version ?? '',
          },
          live?.meta
        );
      });
    const hubNodeId = this.hubNodeId() ?? this.config.nodeId ?? this.userStore.getHubMeta()?.nodeId;
    const hubName = hubNodeId ? this.nodeDisplayName(hubNodeId) : null;
    if (hubNodeId) {
      this.userStore.upsertHubMeta({
        nodeId: hubNodeId,
        publicUrl: this.config.publicUrl,
        now: this.now(),
        listVersion: version,
      });
      const existing = nodes.find((n) => n.id === hubNodeId);
      upsertById(
        nodes,
        projectNode(
          hubNodeId,
          hubName ?? hubNodeId,
          true,
          {
            endpoints: existing?.endpoints ?? [],
            inventory: existing?.inventory ?? {},
            directCapable: existing?.direct_capable ?? false,
            version: existing?.version ?? '',
          },
          online.get(hubNodeId)?.meta
        )
      );
    }
    const hubRecords = this.meshHubs.list();
    const ownId = this.hubNodeId();
    const hubs = hubRecords
      .slice(0, UPLINK_CTL_MAX_HUBS)
      .map((row) => this.toHubEndpoint(row, ownId));
    const writerId = pickWriterHub(hubRecords);
    const writer = writerId ? this.meshHubs.get(writerId) : null;
    const writerName = writer?.name?.trim() || null;
    const legacyHub = writer
      ? {
          nodeId: writer.hubNodeId,
          publicUrl: writer.publicUrl,
          ...(writerName ? { name: writerName } : {}),
        }
      : hubNodeId
        ? {
            nodeId: hubNodeId,
            publicUrl: this.config.publicUrl,
            ...(hubName ? { name: hubName } : {}),
          }
        : undefined;
    return {
      t: 'node.list',
      version,
      key_log_head: { seq: seqToWire(head.seq), hash: bytesToB64url(head.hash) },
      rtc: { stun: this.config.stun, turn: this.config.turn ?? null },
      nodes,
      ...(legacyHub ? { hub: legacyHub } : {}),
      ...(hubs.length > 0 ? { hubs } : {}),
      ...(writerId ? { writerHubId: writerId, writerEpoch: writer?.writerEpoch } : {}),
    };
  }

  private upsertSelfHub(): void {
    const hubNodeId = this.hubNodeId();
    if (!hubNodeId) return;
    const existing = this.meshHubs.get(hubNodeId);
    const now = this.now();
    this.meshHubs.upsert(
      {
        hubNodeId,
        publicUrl: this.config.publicUrl,
        name: this.nodeDisplayName(hubNodeId),
        mode: this.currentMode,
        priority: this.hubPriority,
        writerEpoch: this.hubWriterEpoch,
        caFingerprint: existing?.caFingerprint ?? null,
        online: true,
        lastSeenAt: now,
      },
      now
    );
  }

  private ingestHubAdvertisement(live: LiveConnection, ad: HubAdvertisement): void {
    const now = this.now();
    const existing = this.meshHubs.get(live.nodeId);
    const liveName = this.registry.get(live.nodeId)?.meta.name?.trim();
    this.meshHubs.upsert(
      {
        hubNodeId: live.nodeId,
        publicUrl: ad.publicUrl,
        name: liveName && liveName !== live.nodeId ? liveName : (existing?.name ?? null),
        mode: ad.mode,
        priority: ad.priority,
        writerEpoch: ad.writerEpoch,
        caFingerprint:
          ad.caFingerprint === undefined ? (existing?.caFingerprint ?? null) : ad.caFingerprint,
        online: true,
        lastSeenAt: now,
      },
      now
    );
    const ownId = this.hubNodeId();
    if (ad.mode !== 'active' || live.nodeId === ownId || this.currentMode !== 'active') return;
    if (ad.writerEpoch > this.hubWriterEpoch) {
      console.error(`[hub] fenced: higher writerEpoch=${ad.writerEpoch} from hub=${live.nodeId}`);
      this.setMode('standby');
      return;
    }
    if (ad.writerEpoch === this.hubWriterEpoch) {
      if (
        this.lastSplitBrainLogAt === null ||
        now - this.lastSplitBrainLogAt >= HUB_SPLIT_BRAIN_LOG_INTERVAL_MS
      ) {
        this.lastSplitBrainLogAt = now;
        console.warn(
          `[hub] split-brain: equal writerEpoch=${ad.writerEpoch} from hub=${live.nodeId}`
        );
      }
    }
  }

  private toHubEndpoint(
    row: {
      hubNodeId: string;
      publicUrl: string;
      name: string | null;
      mode: HubMode;
      priority: number;
      writerEpoch: number;
      caFingerprint: string | null;
      lastSeenAt: number | null;
    },
    ownId: string | undefined
  ): HubEndpointInfo {
    const info: HubEndpointInfo = {
      nodeId: row.hubNodeId,
      publicUrl: row.publicUrl,
      mode: row.mode,
      priority: row.priority,
      writerEpoch: row.writerEpoch,
      online: row.hubNodeId === ownId || Boolean(this.registry.get(row.hubNodeId)?.authenticated),
      lastSeenAt: row.lastSeenAt,
    };
    if (row.name) info.name = row.name;
    if (row.caFingerprint !== undefined) info.caFingerprint = row.caFingerprint;
    return info;
  }

  private nodeDisplayName(nodeId: string): string {
    const registry = this.userStore.getNode(nodeId)?.name?.trim();
    if (registry && registry !== nodeId) return registry;
    return this.config.siteName?.trim() || os.hostname().trim() || nodeId;
  }
}

function nodeListFingerprint(msg: NodeListMessage): string {
  return JSON.stringify({ ...msg, version: 0 });
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function parseRelayOpen(payload: Uint8Array): { to: string; raw: Record<string, unknown> } | null {
  try {
    const parsed: unknown = JSON.parse(textDecoder.decode(payload));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.to !== 'string' || obj.to.length === 0) return null;
    if (typeof obj.method === 'string') return null;
    return { to: obj.to, raw: obj };
  } catch {
    return null;
  }
}

function pumpRelay(a: LinkStream, b: LinkStream): void {
  let finished = false;
  const abortBoth = (): void => {
    if (finished) return;
    finished = true;
    try {
      a.reset('relay-rst');
    } catch {
      // already closed
    }
    try {
      b.reset('relay-rst');
    } catch {
      // already closed
    }
  };
  a.onAbort(abortBoth);
  b.onAbort(abortBoth);
  void pumpLink(a, b, abortBoth);
  void pumpLink(b, a, abortBoth);
}

function parseDcPeerSession(rtcSession: string): { a: string; b: string } | null {
  if (!rtcSession.startsWith('dc:')) return null;
  const rest = rtcSession.slice(3);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const first = rest.slice(0, idx).toLowerCase();
  const second = rest.slice(idx + 1).toLowerCase();
  if (!first || !second || first === second) return null;
  const a = first < second ? first : second;
  const b = first < second ? second : first;
  return { a, b };
}
