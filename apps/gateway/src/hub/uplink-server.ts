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
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
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
  type NodeListMessage,
  type RtcSignalMessage,
  type UplinkCtlMessage,
  b64urlToBytes,
  bytesToB64url,
  decodeUplinkCtl,
  encodeUplinkCtl,
  seqToWire,
} from './uplink-protocol';

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
};

type PendingAuth = {
  nonce: Uint8Array;
};

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

export const HUB_KEY_LOG_REQ_RATE_PER_MIN = 10;
export const HUB_KEY_LOG_REQ_BURST = 20;
export const HUB_KEY_LOG_REQ_LOG_INTERVAL_MS = 10_000;

class TokenBucket {
  private tokens: number;
  private lastMs = 0;

  constructor(
    private readonly ratePerMin: number,
    private readonly burst: number
  ) {
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (this.lastMs === 0) {
      this.lastMs = now;
    } else {
      const elapsed = Math.max(0, now - this.lastMs);
      this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerMin) / 60_000);
      this.lastMs = now;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export class UplinkServer {
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly keyLogSource: HubKeyLogSource;
  readonly registry: NodeRegistry;
  private readonly config: HubRuntimeConfig;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatMissLimit: number;
  private readonly authTimeoutMs: number;
  private readonly rtcMaxSessions: number;
  private readonly pending = new WeakMap<LinkSession, PendingAuth>();
  private readonly live = new Map<LinkSession, LiveConnection>();
  private readonly accepted = new Set<LinkSession>();
  private readonly authTimers = new Map<LinkSession, ReturnType<typeof setTimeout>>();
  private readonly ctlQueues = new WeakMap<LinkSession, Promise<void>>();
  private readonly rtcSessions = new Map<string, RtcSessionRegistration>();
  private listVersion = 0;
  private stopped = false;
  private readonly keyLogReqBuckets = new Map<string, TokenBucket>();
  private readonly keyLogReqLogs = new Map<string, { lastAt: number; suppressed: number }>();

  constructor(opts: UplinkServerOptions) {
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.keyLogSource = opts.keyLogSource;
    this.registry = opts.registry;
    this.config = opts.config;
    this.now = opts.now ?? Date.now;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS;
    this.heartbeatMissLimit = opts.heartbeatMissLimit ?? HUB_HEARTBEAT_MISS_LIMIT;
    this.authTimeoutMs = opts.authTimeoutMs ?? HUB_AUTH_TIMEOUT_MS;
    this.rtcMaxSessions = opts.rtcMaxSessions ?? HUB_RTC_MAX_SESSIONS;
    if (opts.config.nodeId) {
      this.userStore.upsertHubMeta({
        nodeId: opts.config.nodeId,
        publicUrl: opts.config.publicUrl,
        now: this.now(),
      });
    }
  }

  accept(link: LinkSession): void {
    const nonce = randomBytes(32);
    this.accepted.add(link);
    this.pending.set(link, { nonce });
    this.armAuthTimer(link);
    this.send(link, { t: 'auth.challenge', nonce: encodeBase64url(nonce) });
    link.ctl.onMessage((bytes) => {
      this.enqueueCtl(link, bytes);
    });
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

  async broadcastNodeList(userId: string): Promise<void> {
    if (this.stopped) return;
    try {
      const msg = await this.buildNodeList(userId);
      if (this.stopped) return;
      for (const entry of this.registry.listForBroadcast(userId)) {
        this.send(entry.link, msg);
      }
    } catch {
      // broadcast is best-effort after persist/ack
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

  stop(): void {
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
    this.registry.closeAll('hub-stop');
  }

  private send(link: LinkSession, msg: UplinkCtlMessage): void {
    try {
      link.ctl.send(encodeUplinkCtl(msg));
    } catch {
      // a dead uplink must never throw out of persist/ack
    }
  }

  private enqueueCtl(link: LinkSession, bytes: Uint8Array): void {
    const prev = this.ctlQueues.get(link) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.onCtl(link, bytes))
      .catch(() => {
        if (this.accepted.has(link)) {
          link.close('ctl-error');
        }
      });
    this.ctlQueues.set(link, next);
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
      if (msg.t === 'auth.response') {
        await this.handleAuthResponse(link, msg.node_id, msg.sig);
      }
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
      link.close('auth-timeout');
      return;
    }
    const cert = this.userStore.getCert(nodeId);
    if (!cert) {
      link.close('unknown-cert');
      return;
    }
    if (cert.revokedLogSeq !== null) {
      link.close('revoked');
      return;
    }
    const nodeRow = this.userStore.getNode(nodeId);
    if (nodeRow?.status === 'revoked') {
      link.close('revoked');
      return;
    }
    let edPk: Uint8Array;
    try {
      edPk = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      link.close('bad-cert');
      return;
    }
    let sig: Uint8Array;
    try {
      sig = b64urlToBytes(sigB64, 64);
    } catch {
      link.close('bad-sig');
      return;
    }
    if (
      !verifyEd25519(
        sig,
        uplinkAuthMessage(pending.nonce, hubHostFromUrl(this.config.publicUrl)),
        edPk
      )
    ) {
      link.close('unauthorized');
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
    await this.broadcastNodeList(userId);
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
          name: live.nodeId,
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
      await this.broadcastNodeList(live.userId);
    } catch {
      if (!this.stopped) throw new Error('node_status_failed');
    }
  }

  private async handleKeyLogReq(
    live: LiveConnection,
    msg: Extract<UplinkCtlMessage, { t: 'key.log.req' }>
  ): Promise<void> {
    let bucket = this.keyLogReqBuckets.get(live.nodeId);
    if (!bucket) {
      bucket = new TokenBucket(HUB_KEY_LOG_REQ_RATE_PER_MIN, HUB_KEY_LOG_REQ_BURST);
      this.keyLogReqBuckets.set(live.nodeId, bucket);
    }
    const fromSeq = BigInt(msg.from_seq);
    if (!bucket.take(this.now())) {
      this.warnKeyLogReq(live.nodeId, fromSeq, 0, true);
      return;
    }
    const records = await this.keyLogSource.list(live.userId, fromSeq);
    this.warnKeyLogReq(live.nodeId, fromSeq, records.length, false);
    this.send(live.link, {
      t: 'key.log.res',
      records: records.map((r) => ({
        seq: seqToWire(r.seq),
        bytes: bytesToB64url(r.bytes),
        sig: bytesToB64url(r.sig),
      })),
      ...(msg.id ? { id: msg.id } : {}),
    });
  }

  private warnKeyLogReq(nodeId: string, fromSeq: bigint, records: number, limited: boolean): void {
    const now = this.now();
    const prev = this.keyLogReqLogs.get(nodeId);
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
    this.keyLogReqLogs.set(nodeId, { lastAt: now, suppressed: 0 });
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
        link.close('auth-timeout');
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
    patchNode(this.db, live.nodeId, { lastSeenAt: this.now() });
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
    this.listVersion += 1;
    const head = await this.keyLogSource.head(userId);
    const online = new Map(
      this.registry.listForBroadcast(userId).map((n) => [n.nodeId, n] as const)
    );
    const nodes = this.userStore
      .listNodes()
      .filter((n) => n.userId === userId && n.status === 'enrolled')
      .map((n) => {
        const live = online.get(n.id);
        return {
          id: n.id,
          name: n.name,
          online: Boolean(live),
          endpoints: live?.meta.endpoints ?? parseJson(n.endpointsJson, []),
          inventory: live?.meta.inventory ?? parseJson(n.inventoryJson, {}),
          direct_capable: live?.meta.directCapable ?? n.directCapable,
          version: live?.meta.version ?? n.version ?? '',
        };
      });
    const hubNodeId = this.config.nodeId ?? this.userStore.getHubMeta()?.nodeId;
    if (hubNodeId) {
      this.userStore.upsertHubMeta({
        nodeId: hubNodeId,
        publicUrl: this.config.publicUrl,
        now: this.now(),
        listVersion: this.listVersion,
      });
    }
    const msg: NodeListMessage = {
      t: 'node.list',
      version: this.listVersion,
      key_log_head: { seq: seqToWire(head.seq), hash: bytesToB64url(head.hash) },
      rtc: {
        stun: this.config.stun,
        turn: this.config.turn ?? null,
      },
      nodes,
    };
    if (hubNodeId) {
      msg.hub = { nodeId: hubNodeId, publicUrl: this.config.publicUrl };
    }
    return msg;
  }
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

function parseJson(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
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
  void copyDirection(a, b, abortBoth);
  void copyDirection(b, a, abortBoth);
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

async function copyDirection(src: LinkStream, dst: LinkStream, onError: () => void): Promise<void> {
  const reader = src.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await dst.write(value.bytes, { head: value.head });
      }
    }
    dst.end();
  } catch {
    onError();
  }
}
