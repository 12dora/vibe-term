import {
  decodeCertificate,
  encodeBase64url,
  hubHostFromUrl,
  randomBytes,
  uplinkAuthMessage,
  verifyEd25519,
} from '@tmex/shared/auth';
import type { LinkSession, LinkStream } from '@tmex/shared/link';
import { decodeB64url } from '../../../../packages/shared/src/auth/b64url';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
import { patchNode } from './node-persistence';
import type { NodeRegistry } from './node-registry';
import type { HubRuntimeConfig } from './types';
import { UPLINK_CTL_MAX_BYTES, type UplinkCtlMessage, encodeUplinkCtl } from './uplink-protocol';
import { IdleLruMap, WindowedLogBudget } from './uplink-rate-limit';
import type {
  LiveConnection,
  LogSuppressState,
  PendingAuth,
  UplinkServerState,
} from './uplink-server-state';
import { drainWithTimeout } from './uplink-server-timers';

type CtlQueueState = {
  depth: number;
  bytes: number;
  tail: Promise<void>;
};

// 按消息数与累计字节双重上限：合法突发（并发 rtc.signal + key.log.req）远超 8 条，但都是小帧
export const HUB_CTL_QUEUE_MAX = 256;
export const HUB_CTL_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const HUB_STOP_DRAIN_TIMEOUT_MS = 5_000;

export const HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS = 10_000;
export const HUB_UPLINK_AUTH_REJECT_LOG_GLOBAL_MAX = 20;
export const HUB_UPLINK_AUTH_REJECT_LOG_ADDR_MAX = 20;
const AUTH_REJECT_ADDR_BUDGET_MAX = 256;

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

export type UplinkAuthSessionDeps = {
  hubNodeId: () => string | undefined;
  isAuthorizedHub: (nodeId: string, userId?: string | null) => boolean;
  onCtl: (link: LinkSession, bytes: Uint8Array) => Promise<void>;
  onIncomingStream: (link: LinkSession, stream: LinkStream) => Promise<void>;
  broadcastNodeList: (userId: string) => Promise<'sent' | 'unchanged' | 'failed'>;
  noteLocalAttach: (nodeId: string) => void;
  noteLocalDetach: (nodeId: string, dropAsHub: boolean) => void;
  dropRtcForNode: (nodeId: string) => void;
};

export type UplinkAuthSessionOptions = {
  state: UplinkServerState;
  db: AuthDb;
  userStore: UserStore;
  registry: NodeRegistry;
  meshHubs: MeshHubStore;
  config: HubRuntimeConfig;
  now: () => number;
  heartbeatIntervalMs: number;
  heartbeatMissLimit: number;
  authTimeoutMs: number;
  logStateMax: number;
  logIdleTtlMs: number;
  deps: UplinkAuthSessionDeps;
};

export class UplinkAuthSession {
  private readonly state: UplinkServerState;
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly registry: NodeRegistry;
  private readonly meshHubs: MeshHubStore;
  private readonly config: HubRuntimeConfig;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMissLimit: number;
  private readonly authTimeoutMs: number;
  private readonly deps: UplinkAuthSessionDeps;
  private readonly pending = new WeakMap<LinkSession, PendingAuth>();
  private readonly ctlQueues = new WeakMap<LinkSession, CtlQueueState>();
  private readonly inflightCtl = new Set<Promise<void>>();
  private readonly linkRemoteAddress = new WeakMap<LinkSession, string>();
  private readonly authRejectLogs: IdleLruMap<LogSuppressState>;
  private readonly authRejectGlobal = new WindowedLogBudget(
    HUB_UPLINK_AUTH_REJECT_LOG_GLOBAL_MAX,
    HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS
  );
  private readonly authRejectByAddr = new Map<string, WindowedLogBudget>();

  constructor(opts: UplinkAuthSessionOptions) {
    this.state = opts.state;
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.meshHubs = opts.meshHubs;
    this.config = opts.config;
    this.now = opts.now;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs;
    this.heartbeatMissLimit = opts.heartbeatMissLimit;
    this.authTimeoutMs = opts.authTimeoutMs;
    this.deps = opts.deps;
    this.authRejectLogs = new IdleLruMap(opts.logStateMax, opts.logIdleTtlMs);
  }

  accept(link: LinkSession, opts?: { remoteAddress?: string }): void {
    if (this.state.stopped) {
      link.close('hub-stop');
      return;
    }
    const nonce = randomBytes(32);
    this.state.accepted.add(link);
    if (opts?.remoteAddress) {
      this.linkRemoteAddress.set(link, opts.remoteAddress);
    }
    this.pending.set(link, { nonce });
    this.armAuthTimer(link);
    this.send(link, { t: 'auth.challenge', nonce: encodeBase64url(nonce) });
    link.ctl.onMessage((bytes) => this.enqueueCtl(link, bytes));
    link.onStream((stream) => {
      void this.deps.onIncomingStream(link, stream);
    });
    void link.closed.then(() => {
      this.onLinkClosed(link);
    });
  }

  async handleAuthResponse(link: LinkSession, nodeId: string, sigB64: string): Promise<void> {
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
      sig = decodeB64url(sigB64, 64);
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
    this.state.live.set(link, live);
    this.startHeartbeat(live);
    this.deps.noteLocalAttach(nodeId);
    this.send(link, { t: 'auth.ok' });
    if ((await this.deps.broadcastNodeList(userId)) === 'unchanged') {
      const cached = this.state.lastNodeListSent.get(userId);
      if (cached) this.sendBytes(link, cached);
    }
  }

  rejectAuth(
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

  private armAuthTimer(link: LinkSession): void {
    this.clearAuthTimer(link);
    const timer = this.state.timers.timeout(
      'auth timeout',
      () => {
        this.state.authTimers.delete(link);
        if (!this.state.live.has(link) && this.state.accepted.has(link)) {
          this.pending.delete(link);
          this.rejectAuth(link, undefined, 'timeout', 'auth-timeout');
        }
      },
      this.authTimeoutMs
    );
    if (timer) this.state.authTimers.set(link, timer);
  }

  clearAuthTimer(link: LinkSession): void {
    const timer = this.state.authTimers.get(link);
    if (timer !== undefined) {
      timer.clear();
      this.state.authTimers.delete(link);
    }
  }

  startHeartbeat(live: LiveConnection): void {
    this.clearHeartbeat(live);
    live.heartbeat = this.state.timers.interval(
      'heartbeat',
      () => this.beat(live),
      this.heartbeatIntervalMs
    );
  }

  private beat(live: LiveConnection): void {
    if (this.state.live.get(live.link) !== live) {
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
    this.state.attachments.refreshLocal(live.nodeId);
    this.send(live.link, { t: 'ping' });
  }

  clearHeartbeat(live: LiveConnection): void {
    live.heartbeat?.clear();
    live.heartbeat = null;
  }

  onLinkClosed(link: LinkSession): void {
    this.pending.delete(link);
    this.clearAuthTimer(link);
    this.state.accepted.delete(link);
    const live = this.state.live.get(link);
    this.state.live.delete(link);
    if (!live) return;
    this.clearHeartbeat(live);
    this.deps.dropRtcForNode(live.nodeId);
    const dropAsHub = this.deps.isAuthorizedHub(live.nodeId, live.userId);
    const removed = this.registry.remove(live.nodeId, live.generation);
    if (!removed || this.state.stopped) return;
    this.deps.noteLocalDetach(live.nodeId, dropAsHub);
    const now = this.now();
    patchNode(this.db, live.nodeId, { lastSeenAt: now });
    const ownId = this.deps.hubNodeId();
    if (live.nodeId !== ownId) {
      const rec = this.meshHubs.get(live.nodeId);
      if (rec) {
        this.meshHubs.upsert({ ...rec, online: false, lastSeenAt: now }, now);
      }
    }
    void this.deps.broadcastNodeList(live.userId);
  }

  assertLiveCert(live: LiveConnection): boolean {
    if (this.certIsRevoked(live.nodeId)) {
      this.evictRevokedNode(live.nodeId);
      return false;
    }
    return true;
  }

  certIsRevoked(nodeId: string): boolean {
    const cert = this.userStore.getCert(nodeId);
    return !cert || cert.revokedLogSeq !== null;
  }

  evictRevokedNode(nodeId: string): void {
    patchNode(this.db, nodeId, { status: 'revoked' });
    this.state.keyLogReqLimiter.delete(nodeId);
    this.state.keyLogReqLogs.delete(nodeId);
    this.deps.dropRtcForNode(nodeId);
    const entry = this.registry.get(nodeId);
    if (!entry) return;
    const live = this.state.live.get(entry.link);
    if (live) {
      this.clearHeartbeat(live);
      this.state.live.delete(entry.link);
    }
    this.registry.remove(nodeId, entry.generation);
    entry.link.close('revoked');
  }

  send(link: LinkSession, msg: UplinkCtlMessage): void {
    this.sendBytes(link, encodeUplinkCtl(msg));
  }

  sendBytes(link: LinkSession, bytes: Uint8Array): void {
    try {
      link.ctl.send(bytes);
    } catch {
      // a dead uplink must never throw out of persist/ack
    }
  }

  sendTo(nodeId: string, msg: UplinkCtlMessage): boolean {
    const entry = this.registry.get(nodeId);
    if (!entry?.authenticated) return false;
    this.send(entry.link, msg);
    return true;
  }

  private enqueueCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    if (this.state.stopped || !this.state.accepted.has(link)) return Promise.resolve();
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
    const run = q.tail.catch(() => undefined).then(() => this.deps.onCtl(link, bytes));
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.trackCtl(settled);
    q.tail = run
      .catch(() => {
        if (this.state.accepted.has(link)) {
          link.close('ctl-error');
        }
      })
      .finally(() => {
        q.depth = Math.max(0, q.depth - 1);
        q.bytes = Math.max(0, q.bytes - bytes.byteLength);
      });
    return settled;
  }

  private trackCtl(work: Promise<void>): void {
    this.inflightCtl.add(work);
    void work.finally(() => {
      this.inflightCtl.delete(work);
    });
  }

  async drainInflight(): Promise<void> {
    const pending = [...this.inflightCtl];
    if (pending.length === 0) return;
    const drained = await drainWithTimeout(pending, this.state.timers, HUB_STOP_DRAIN_TIMEOUT_MS);
    if (!drained) console.warn('[hub] uplink stop drain timed out; continuing');
  }

  disconnect(nodeId: string, reason = 'disconnected'): boolean {
    const entry = this.registry.get(nodeId);
    if (!entry) return false;
    entry.link.close(reason);
    return true;
  }

  clearAuthRejectLogs(): void {
    this.authRejectLogs.clear();
    this.authRejectGlobal.clear();
    this.authRejectByAddr.clear();
  }
}
