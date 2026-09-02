import {
  bytesEqual,
  computeRecordHash,
  decodeAuthorization,
  decodeBase64url,
  decodeCertificate,
  decodeKeyLogRecord,
  decodeRevokeNodePayload,
  encodeBase64url,
  nodeIdToHex,
  sha256,
  verifyEd25519,
  verifyNodeCertificate,
} from '@tmex/shared/auth';
import {
  type LinkSession,
  type LinkStream,
  type ServerSocketAdapter,
  WebSocketLink,
} from '@tmex/shared/link';
import type {
  HubAttachmentsMessage,
  HubForwardMessage,
  HubMode,
  HubTokensMessage,
  HubWriteForwardMessage,
} from '@tmex/shared/uplink';
import { json, readJsonObjectBody } from '../api/http';
import { matchPath } from '../api/route';
import { decodeB64url, requireB64url, validationError } from '../api/route-input';
import type { HubTrustStore } from '../auth/hub-trust-store';
import { MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import { makeVerifyPasskeyAssertion } from '../auth/passkey';
import type { AuthDb } from '../auth/types';
import { type UserRecord, UserStore } from '../auth/user-store';
import { inspectHubAuthRecordCompat } from './hub-authorization';
import { decodeCertificateIdentityKeys, parseKdfParams } from './hub-cert-keys';
import { type HubPeerFetch, HubPeerPoller } from './hub-peer-poller';
import {
  type UplinkNodeList,
  applyReplicatedNodeList as replicateNodeList,
} from './hub-replication';
import {
  type PatchHubRoleEnv,
  type ScheduleHubRoleRestart,
  executeHubRoleTransition,
  handleGetHubRoleStatus,
  handlePostHubRole,
  knownMaxWriterEpoch,
  reconcileHubRoleOnStart,
} from './hub-role-routes';
import { HubRoleTransitionStore } from './hub-role-transitions';
import {
  HUB_TOKENS_ACK_WAIT_MS,
  applyHubTokensMessage,
  hubTokensAck,
  peerSupportsHubTokens,
  upsertHubTokensMessage,
} from './hub-tokens';
import { detachEnrollmentTokensFromNode, patchNode } from './node-persistence';
import { NodeRegistry } from './node-registry';
import { encodeRedeemPopMessage } from './redeem-pop';
import {
  HUB_AUTH_TIMEOUT_MS,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_HEARTBEAT_MISS_LIMIT,
  HUB_UPLINK_PATH,
  HUB_UPLINK_WS_KIND,
  type HubAuthResult,
  type HubAuthenticate,
  type HubKeyLogSource,
  type HubRuntimeConfig,
  type HubUplinkSocketData,
} from './types';
import { type RegisterRtcSessionInput, UplinkServer } from './uplink-server';
import {
  WRITER_FORWARD_TIMEOUT_MS,
  WriteForwardAckAssembler,
  forwardWriteToWriter,
  notWriterResponse,
  requestAlreadyForwarded,
} from './writer-forward';

export type HubUpgradeServer = {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

export type HubServerWebSocket = {
  data: HubUplinkSocketData & { adapter?: BunServerWsAdapter };
  send(data: Uint8Array | ArrayBuffer | ArrayBufferView | string): number | undefined;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
};

export type HubTlsInfo = {
  caFingerprint: string | null;
  caPem: string | null;
};

export type HubTlsInfoProvider = () => HubTlsInfo | Promise<HubTlsInfo>;

export type HubRuntimeOptions = {
  db: AuthDb;
  userStore: UserStore;
  keyLogSource: HubKeyLogSource;
  config: HubRuntimeConfig;
  authenticate: HubAuthenticate;
  now?: () => number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
  tlsInfo?: HubTlsInfoProvider;
  meshHubs?: MeshHubStore;
  hubTrust?: HubTrustStore;
  fetchPeerStatus?: HubPeerFetch;
  hubFetch?: HubPeerFetch;
  patchHostEnv?: PatchHubRoleEnv | null;
  scheduleRestart?: ScheduleHubRoleRestart;
  hubRoleInstalled?: boolean;
  autoPromote?: boolean;
  autoPromoteTimeoutMs?: number;
};

type ForwardedWriteCtx = {
  path: string;
  req: Request;
  auth: HubAuthResult | null;
};

export type HubCtlSource = {
  hubNodeId: string;
  generation: number;
};

export type HubWriterBridge = {
  appendAndAck(record: { bytes: Uint8Array; sig: Uint8Array; force?: boolean }): Promise<{
    ok: boolean;
    seq?: bigint | number;
    error?: string;
  } | null>;
  requestCatchUp(): void;
  sendCtl(
    msg: HubTokensMessage | HubAttachmentsMessage | HubForwardMessage | HubWriteForwardMessage
  ): void;
  openStream(openPayload: Uint8Array): Promise<LinkStream>;
  isLive(): boolean;
};

type StoredEnrollmentPayload = {
  authorization_b64: string;
  entry_node_id: string | null;
  entry_sid?: string | null;
  certificate_b64?: string;
  cert_sig_b64?: string;
  node_id?: string;
};

export class BunServerWsAdapter implements ServerSocketAdapter {
  private messageCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private drainCb: (() => void) | null = null;

  constructor(private readonly socket: HubServerWebSocket) {}

  send(bytes: Uint8Array): number {
    return this.socket.send(bytes) ?? bytes.byteLength;
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  bufferedAmount(): number {
    return this.socket.getBufferedAmount?.() ?? 0;
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (reason?: string) => void): void {
    this.closeCb = cb;
  }

  onDrain(cb: () => void): void {
    this.drainCb = cb;
  }

  dispatchMessage(data: string | ArrayBuffer | Uint8Array): void {
    const bytes =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    this.messageCb?.(bytes);
  }

  dispatchClose(_code?: number, reason?: string): void {
    this.closeCb?.(reason);
  }

  dispatchDrain(): void {
    this.drainCb?.();
  }
}

export class HubRuntime {
  private readonly db: AuthDb;
  private readonly userStore: UserStore;
  private readonly keyLogSource: HubKeyLogSource;
  private readonly authenticate: HubAuthenticate;
  private readonly now: () => number;
  private readonly config: HubRuntimeConfig;
  private readonly tlsInfo: HubTlsInfoProvider | undefined;
  readonly registry: NodeRegistry;
  readonly uplink: UplinkServer;
  readonly meshHubs: MeshHubStore;
  readonly peerPoller: HubPeerPoller;
  private readonly modeListeners = new Set<() => void>();
  private readonly patchHostEnv: PatchHubRoleEnv | null;
  private readonly scheduleRestart: ScheduleHubRoleRestart | undefined;
  private readonly hubRoleInstalled: boolean;
  private readonly hubTrust: HubTrustStore | undefined;
  private readonly hubFetch: HubPeerFetch | undefined;
  private writerBridge: HubWriterBridge | null = null;
  private readonly writeForwardWaiters = new Map<
    string,
    { resolve: (msg: HubWriteForwardMessage | null) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly writeForwardAcks = new WriteForwardAckAssembler();

  constructor(opts: HubRuntimeOptions) {
    this.db = opts.db;
    this.userStore = opts.userStore;
    this.keyLogSource = opts.keyLogSource;
    this.authenticate = opts.authenticate;
    this.now = opts.now ?? Date.now;
    this.config = opts.config;
    this.tlsInfo = opts.tlsInfo;
    this.meshHubs = opts.meshHubs ?? new MeshHubStore(opts.db);
    this.patchHostEnv = opts.patchHostEnv ?? null;
    this.scheduleRestart = opts.scheduleRestart;
    this.hubRoleInstalled = opts.hubRoleInstalled ?? true;
    this.registry = new NodeRegistry();
    this.hubTrust = opts.hubTrust;
    this.hubFetch = opts.hubFetch ?? opts.fetchPeerStatus;
    this.uplink = new UplinkServer({
      db: opts.db,
      userStore: opts.userStore,
      keyLogSource: opts.keyLogSource,
      registry: this.registry,
      config: opts.config,
      meshHubs: this.meshHubs,
      now: this.now,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS,
      heartbeatMissLimit: opts.heartbeatMissLimit ?? HUB_HEARTBEAT_MISS_LIMIT,
      authTimeoutMs: opts.authTimeoutMs ?? HUB_AUTH_TIMEOUT_MS,
      onModeChange: () => {
        this.peerPoller.noteRoleTransition();
        for (const cb of this.modeListeners) {
          try {
            cb();
          } catch {}
        }
      },
      onNewAuthorizedHub: () => {
        void this.peerPoller.pollNow();
      },
      forwardAppend: async (record) => {
        const bridge = this.writerBridge;
        if (!bridge?.isLive()) return null;
        try {
          return await bridge.appendAndAck(record);
        } catch {
          return null;
        }
      },
      onWriteForward: (fromHubId, msg) => this.executeForwardedWrite(fromHubId, msg),
      onForwardedWrite: () => this.writerBridge?.requestCatchUp(),
      openHubStream: (hubId, payload) => this.openHubStream(hubId, payload),
      forwardHubCtl: (msg) => {
        try {
          this.writerBridge?.sendCtl(msg);
        } catch {
          /* offline */
        }
      },
    });
    this.peerPoller = new HubPeerPoller({
      meshHubs: this.meshHubs,
      selfHubId: () => this.uplink.hubNodeId(),
      isAuthorized: (id) => this.uplink.isAuthorizedHub(id),
      applyStatus: (hubNodeId, ad) =>
        this.uplink.applyAuthorizedHubAdvertisement(hubNodeId, ad, 'peer-status'),
      onChanged: () => this.uplink.broadcastAllNodeLists(),
      now: this.now,
      fetch: opts.fetchPeerStatus,
      hubTrust: opts.hubTrust,
      autoPromote: opts.autoPromote ?? false,
      autoPromoteTimeoutMs: opts.autoPromoteTimeoutMs,
      selfMode: () => this.uplink.mode(),
      selfPriority: () => this.config.priority ?? (this.uplink.mode() === 'standby' ? 200 : 100),
      selfWriterEpoch: () => this.uplink.writerEpoch(),
      onAutoPromote: (operationId) => this.runAutoPromote(operationId),
    });
    if (opts.hubTrust) this.peerPoller.start();
    reconcileHubRoleOnStart(this.roleContext());
  }

  private roleContext() {
    return {
      db: this.db,
      uplink: this.uplink,
      meshHubs: this.meshHubs,
      now: this.now,
      patchHostEnv: this.patchHostEnv,
      scheduleRestart: this.scheduleRestart,
      hubRoleInstalled: this.hubRoleInstalled,
      configMode: this.config.mode ?? 'active',
      configWriterEpoch: this.config.writerEpoch ?? 1,
    };
  }

  mode(): HubMode {
    return this.uplink.mode();
  }

  setMode(mode: HubMode): void {
    this.uplink.setMode(mode);
  }

  setWriterEpoch(epoch: number): void {
    this.uplink.setWriterEpoch(epoch);
  }

  onModeChange(cb: () => void): () => void {
    this.modeListeners.add(cb);
    return () => {
      this.modeListeners.delete(cb);
    };
  }

  writerEpoch(): number {
    return this.uplink.writerEpoch();
  }

  updateSelfCaFingerprint(fp: string | null): void {
    this.uplink.updateSelfCaFingerprint(fp);
  }

  applyReplicatedNodeList(list: UplinkNodeList, meta: { hubNodeId: string | null }): void {
    const ownId = this.uplink.hubNodeId();
    if (ownId && meta.hubNodeId === ownId) return;
    const before = new Set(
      this.meshHubs
        .list()
        .filter((row) => this.uplink.isAuthorizedHub(row.hubNodeId))
        .map((row) => row.hubNodeId)
    );
    replicateNodeList(
      this.db,
      this.userStore,
      this.meshHubs,
      list,
      meta,
      {
        hubNodeId: ownId,
        record: this.uplink.ownHubSnapshot(),
        authorizedHubIds: this.config.authorizedHubIds,
        isAuthorizedHub: (id) => this.uplink.isAuthorizedHub(id),
      },
      this.now()
    );
    this.uplink.broadcastAllNodeLists();
    const added = this.meshHubs
      .list()
      .some(
        (row) =>
          this.uplink.isAuthorizedHub(row.hubNodeId) &&
          row.hubNodeId !== ownId &&
          !before.has(row.hubNodeId)
      );
    if (added) void this.peerPoller.pollNow();
  }

  pollPeersNow(): Promise<void> {
    return this.peerPoller.pollNow();
  }

  private requireWriter(): Response | null {
    return this.uplink.isWriter() ? null : json(this.uplink.notWriterError(), 409);
  }

  bindWriterBridge(bridge: HubWriterBridge | null): void {
    this.writerBridge = bridge;
  }

  receiveHubTokens(msg: HubTokensMessage, source?: HubCtlSource): void {
    if (msg.ack) return;
    const from = source?.hubNodeId;
    const writer = pickWriterHub(
      this.meshHubs.list().filter((row) => this.uplink.isAuthorizedHub(row.hubNodeId))
    );
    if (!from || from !== writer) {
      console.warn(`[hub] hub.tokens dropped on standby: attached=${from} writer=${writer}`);
      return;
    }
    const senderEpoch = this.meshHubs.get(from)?.writerEpoch ?? 0;
    let localMax = this.uplink.writerEpoch();
    for (const row of this.meshHubs.list()) {
      if (row.writerEpoch > localMax) localMax = row.writerEpoch;
    }
    if (senderEpoch < localMax) {
      console.warn(
        `[hub] hub.tokens dropped: senderEpoch=${senderEpoch} < localMax=${localMax} from=${from}`
      );
      return;
    }
    const uid = this.uplink.meshUserId();
    applyHubTokensMessage(this.userStore, msg, uid ?? undefined);
    if (msg.id) {
      try {
        this.writerBridge?.sendCtl(hubTokensAck(msg));
      } catch {
        /* offline */
      }
    }
  }

  receiveHubAttachments(msg: HubAttachmentsMessage, source?: HubCtlSource): void {
    const from = source?.hubNodeId;
    if (!from) return;
    const writer = pickWriterHub(
      this.meshHubs.list().filter((row) => this.uplink.isAuthorizedHub(row.hubNodeId))
    );
    if (writer && from !== writer) {
      console.warn(`[hub] hub.attachments dropped: source=${from} writer=${writer}`);
      return;
    }
    this.uplink.ingestHubAttachments(from, msg);
  }

  receiveHubForward(msg: HubForwardMessage, source?: HubCtlSource): void {
    const from = source?.hubNodeId;
    if (!from) return;
    this.uplink.ingestHubForward(from, msg);
  }

  receiveHubRelay(stream: LinkStream, source?: HubCtlSource): void {
    const from = source?.hubNodeId;
    if (!from) {
      stream.reset('unauthenticated');
      return;
    }
    this.uplink.ingestHubRelay(from, stream);
  }

  onWriterUplinkOnline(): void {
    this.uplink.publishLocalAttachments();
  }

  onWriterUplinkOffline(): void {
    const writer = this.writerPeerId();
    if (writer && writer !== this.uplink.hubNodeId()) {
      this.uplink.attachments.dropHub(writer);
      this.uplink.resetCrossHubRelays(writer);
    }
  }

  private writerPeerId(): string | null {
    return (
      pickWriterHub(
        this.meshHubs.list().filter((row) => this.uplink.isAuthorizedHub(row.hubNodeId))
      ) ??
      this.uplink.hubNodeId() ??
      null
    );
  }

  private async openHubStream(hubId: string, payload: Uint8Array): Promise<LinkStream | null> {
    const own = this.uplink.hubNodeId();
    if (own && hubId === own) return null;
    const local = this.registry.get(hubId);
    if (local?.authenticated && this.uplink.isAuthorizedHub(hubId, local.userId)) {
      try {
        return await local.link.openStream(payload);
      } catch {
        return null;
      }
    }
    const bridge = this.writerBridge;
    if (!bridge?.isLive()) return null;
    try {
      return await bridge.openStream(payload);
    } catch {
      return null;
    }
  }

  async forwardWrite(req: Request, uid?: string | null): Promise<Response | null> {
    const err = this.uplink.notWriterError();
    const writerId = err.writerHubId;
    const version = writerId
      ? (this.registry.get(writerId)?.meta.version ?? this.userStore.getNode(writerId)?.version)
      : null;
    const live = Boolean(this.writerBridge?.isLive());
    if (version && !peerSupportsHubTokens(version) && !live) return null;
    const forwarded = await forwardWriteToWriter(req, {
      selfHubId: this.uplink.hubNodeId() ?? this.config.hubNodeId ?? this.config.nodeId ?? '',
      uid,
      target: {
        writerHubId: err.writerHubId,
        writerPublicUrl: err.writerPublicUrl,
        writerEpoch: err.writerEpoch,
      },
      isLive: () => Boolean(this.writerBridge?.isLive()),
      send: (msg) => {
        this.writerBridge?.sendCtl(msg);
      },
      waitAck: (id) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.writeForwardWaiters.delete(id);
            this.writeForwardAcks.drop(id);
            resolve(null);
          }, WRITER_FORWARD_TIMEOUT_MS);
          this.writeForwardWaiters.set(id, { resolve, timer });
        }),
    });
    if (forwarded) this.writerBridge?.requestCatchUp();
    return forwarded;
  }

  receiveHubWriteForward(msg: HubWriteForwardMessage, _source?: HubCtlSource): void {
    if (!msg.ack || !msg.id) return;
    const assembled = this.writeForwardAcks.push(msg);
    if (!assembled) return;
    const waiter = this.writeForwardWaiters.get(assembled.id);
    if (!waiter) return;
    this.writeForwardWaiters.delete(assembled.id);
    clearTimeout(waiter.timer);
    waiter.resolve(assembled);
  }

  async executeForwardedWrite(
    fromHubId: string,
    msg: HubWriteForwardMessage
  ): Promise<HubWriteForwardMessage> {
    const res = await this.dispatchForwardedWrite(fromHubId, msg);
    const contentType = res.headers.get('content-type') ?? undefined;
    const body = await res.text();
    const ack: HubWriteForwardMessage = {
      t: 'hub.write-forward',
      id: msg.id,
      ack: true,
      status: res.status,
    };
    if (contentType) ack.headers = { 'content-type': contentType };
    if (body) ack.body = body;
    return ack;
  }

  /**
   * 写者执行 standby 经已认证 hub uplink 转发的写入。
   * 载荷自认证（enrollment 用户签名、redeem 证书、revoke/keylog 签名记录）。
   * rename 的 uid 仅因发送方是已授权 hub 而被接受：standby 断言「该用户已在本机通过会话认证」。
   */
  private async dispatchForwardedWrite(
    fromHubId: string,
    msg: HubWriteForwardMessage
  ): Promise<Response> {
    const ctx = this.forwardedWriteCtx(fromHubId, msg);
    return (
      (await this.dispatchForwardedRedeem(ctx)) ??
      (await this.dispatchForwardedCreateEnrollment(ctx)) ??
      (await this.dispatchForwardedRename(ctx)) ??
      (await this.dispatchForwardedRevoke(ctx)) ??
      (await this.dispatchForwardedKeyLogPost(ctx)) ??
      json({ error: 'not_found' }, 404)
    );
  }

  private forwardedWriteCtx(fromHubId: string, msg: HubWriteForwardMessage): ForwardedWriteCtx {
    const path = (msg.path ?? '/').split('?')[0] ?? '/';
    const url = `http://hub${msg.path ?? '/'}`;
    const headers = new Headers();
    if (msg.headers?.['content-type']) headers.set('content-type', msg.headers['content-type']);
    if (msg.headers?.['x-tmex-force-keylog']) {
      headers.set('x-tmex-force-keylog', msg.headers['x-tmex-force-keylog']);
    }
    const req = new Request(url, {
      method: msg.method ?? 'POST',
      headers,
      body: msg.method === 'GET' || msg.method === 'HEAD' ? undefined : (msg.body ?? ''),
    });
    const auth: HubAuthResult | null = msg.uid ? { userId: msg.uid, entryNodeId: fromHubId } : null;
    return { path, req, auth };
  }

  private async dispatchForwardedRedeem(ctx: ForwardedWriteCtx): Promise<Response | undefined> {
    if (ctx.path !== '/api/hub/enrollments/redeem' || ctx.req.method !== 'POST') return undefined;
    return this.handleRedeem(ctx.req);
  }

  private async dispatchForwardedCreateEnrollment(
    ctx: ForwardedWriteCtx
  ): Promise<Response | undefined> {
    if (ctx.path !== '/api/hub/enrollments' || ctx.req.method !== 'POST') return undefined;
    if (!ctx.auth) return json({ error: 'unauthorized' }, 401);
    return this.handleCreateEnrollment(ctx.req, ctx.auth);
  }

  private async dispatchForwardedRename(ctx: ForwardedWriteCtx): Promise<Response | undefined> {
    const rename = ctx.path.match(/^\/api\/hub\/nodes\/([^/]+)\/rename$/);
    if (!rename || ctx.req.method !== 'POST') return undefined;
    if (!ctx.auth) return json({ error: 'unauthorized' }, 401);
    return this.handleRename(ctx.req, decodeURIComponent(rename[1] ?? ''), ctx.auth);
  }

  private async dispatchForwardedRevoke(ctx: ForwardedWriteCtx): Promise<Response | undefined> {
    const revoke = ctx.path.match(/^\/api\/hub\/nodes\/([^/]+)\/revoke$/);
    if (!revoke || ctx.req.method !== 'POST') return undefined;
    if (!ctx.auth) return json({ error: 'unauthorized' }, 401);
    return this.handleRevoke(ctx.req, decodeURIComponent(revoke[1] ?? ''), ctx.auth);
  }

  private async dispatchForwardedKeyLogPost(ctx: ForwardedWriteCtx): Promise<Response | undefined> {
    if (ctx.path !== '/api/auth/keylog' || ctx.req.method !== 'POST') return undefined;
    if (!ctx.auth) return json({ error: 'unauthorized' }, 401);
    return this.handleForwardedKeyLog(ctx.req, ctx.auth.userId);
  }

  private async handleForwardedKeyLog(req: Request, userId: string): Promise<Response> {
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'MALFORMED' }, 400);
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = requireB64url(body, 'bytes');
      sig = requireB64url(body, 'sig', 64);
    } catch (err) {
      return validationError(err);
    }
    const already = await this.identicalForwardedKeyLog(userId, bytes, sig);
    if (already) {
      return json({ ok: true, seq: already.seq, hash: encodeBase64url(already.hash) });
    }
    const compat = inspectHubAuthRecordCompat(this.userStore, bytes, userId);
    const forced = req.headers.get('x-tmex-force-keylog') === '1';
    if (!compat.ok) {
      if (forced) {
        console.warn(
          `[auth] forcing key-log append despite ${compat.code} minVersion=${compat.minVersion} nodes=${compat.nodes
            .map((n) => n.id)
            .join(',')}`
        );
      } else {
        return json({ code: compat.code, minVersion: compat.minVersion, nodes: compat.nodes }, 409);
      }
    }
    const result = await this.keyLogSource.append(userId, { bytes, sig });
    if (!result.ok) return json({ error: result.error }, 400);
    await this.uplink.applyAppendEffects(userId, result);
    return json({
      ok: true,
      seq: result.seq,
      hash: encodeBase64url(result.hash),
    });
  }

  private async identicalForwardedKeyLog(
    userId: string,
    bytes: Uint8Array,
    sig: Uint8Array
  ): Promise<{ seq: bigint; hash: Uint8Array } | null> {
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
    return { seq, hash: computeRecordHash(existing.bytes, existing.sig) };
  }

  private async requireWriterOrForward(
    req: Request,
    uid?: string | null
  ): Promise<Response | null> {
    if (this.uplink.isWriter()) return null;
    if (requestAlreadyForwarded(req)) return notWriterResponse(this.uplink.notWriterError());
    const forwarded = await this.forwardWrite(req, uid);
    if (forwarded) return forwarded;
    return json(this.uplink.notWriterError(), 409);
  }

  private handleHubStatus(): Response {
    const snap = this.uplink.ownHubSnapshot();
    if (!snap) return json({ error: 'hub_unconfigured' }, 503);
    const writerView = this.peerPoller.localWriterView();
    return json({
      hubNodeId: snap.hubNodeId,
      publicUrl: snap.publicUrl,
      mode: snap.mode,
      priority: snap.priority,
      writerEpoch: snap.writerEpoch,
      ...(snap.name ? { name: snap.name } : {}),
      caFingerprint: snap.caFingerprint,
      now: this.now(),
      ...(writerView ? { writerView } : {}),
      peerPollFast: this.peerPoller.inFastPoll(),
    });
  }

  private async runAutoPromote(operationId: string): Promise<void> {
    const ctx = this.roleContext();
    const self = this.uplink.hubNodeId();
    if (!self) return;
    if (!ctx.patchHostEnv) {
      console.error('[hub] auto-promote skipped: host env patcher is not available');
      return;
    }
    try {
      if (new HubRoleTransitionStore(ctx.db).inFlight().length > 0) {
        console.error('[hub] auto-promote skipped: a hub role transition is already in progress');
        return;
      }
    } catch {
      /* 旧库尚未迁移时忽略 in-flight 检查，仍尝试 promote */
    }
    const writerEpoch = knownMaxWriterEpoch(ctx) + 1;
    console.error(
      `[hub] auto-promote applying mode=active writerEpoch=${writerEpoch} operationId=${operationId}`
    );
    await executeHubRoleTransition(ctx, {
      operationId,
      mode: 'active',
      writerEpoch,
      targetHubId: self,
    });
  }

  attachLocalNode(link: LinkSession): void {
    this.uplink.accept(link);
  }

  registerRtcSession(input: RegisterRtcSessionInput): string | null {
    return this.uplink.registerRtcSession(input);
  }

  async stop(): Promise<void> {
    this.peerPoller.stop();
    await this.uplink.stop();
  }

  async handleRequest(req: Request, server: HubUpgradeServer): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    if (path === HUB_UPLINK_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json({ error: 'method_not_allowed' }, 405);
      }
      const ok = server.upgrade(req, {
        data: { kind: HUB_UPLINK_WS_KIND } satisfies HubUplinkSocketData,
      });
      return ok ? undefined : json({ error: 'upgrade_failed' }, 500);
    }
    if (!path.startsWith('/api/hub/')) return undefined;
    const hit = (
      pattern: string,
      method: string,
      fn: (p: Record<string, string>) => Response | Promise<Response>
    ) => {
      const params = matchPath(path, pattern);
      if (!params) return;
      if (req.method !== method) return json({ error: 'method_not_allowed' }, 405);
      return fn(params);
    };
    return (
      hit('/api/hub/status', 'GET', () => this.handleHubStatus()) ??
      hit('/api/hub/role/status', 'GET', () =>
        this.withAuth(req, () => handleGetHubRoleStatus(req, this.roleContext()))
      ) ??
      hit('/api/hub/role', 'POST', () =>
        this.withAuth(req, () => handlePostHubRole(req, this.roleContext()))
      ) ??
      hit('/api/hub/enrollments/redeem', 'POST', async () => {
        const blocked = await this.requireWriterOrForward(req);
        return blocked ?? this.handleRedeem(req);
      }) ??
      hit('/api/hub/enrollments', 'POST', () =>
        this.withAuth(req, async (a) => {
          const blocked = await this.requireWriterOrForward(req, a.userId);
          return blocked ?? this.handleCreateEnrollment(req, a);
        })
      ) ??
      hit('/api/hub/enrollments/:id', 'GET', (p) =>
        this.withAuth(req, (a) => this.handleGetEnrollment(decodeURIComponent(p.id), a))
      ) ??
      hit('/api/hub/nodes', 'GET', () => this.withAuth(req, (a) => this.handleListNodes(a))) ??
      hit('/api/hub/nodes/:id/rename', 'POST', (p) =>
        this.withAuth(req, async (a) => {
          const blocked = await this.requireWriterOrForward(req, a.userId);
          return blocked ?? this.handleRename(req, decodeURIComponent(p.id), a);
        })
      ) ??
      hit('/api/hub/nodes/:id/revoke', 'POST', (p) =>
        this.withAuth(req, async (a) => {
          const blocked = await this.requireWriterOrForward(req, a.userId);
          return blocked ?? this.handleRevoke(req, decodeURIComponent(p.id), a);
        })
      ) ??
      json({ error: 'not_found' }, 404)
    );
  }

  handleUplinkOpen(ws: HubServerWebSocket): void {
    const adapter = new BunServerWsAdapter(ws);
    ws.data.adapter = adapter;
    const remote = (ws as unknown as { remoteAddress?: unknown }).remoteAddress;
    this.uplink.accept(
      new WebSocketLink(adapter, { role: 'acceptor' }),
      typeof remote === 'string' ? { remoteAddress: remote } : undefined
    );
  }

  handleUplinkMessage(ws: HubServerWebSocket, message: string | ArrayBuffer | Uint8Array): void {
    ws.data.adapter?.dispatchMessage(message);
  }

  handleUplinkClose(ws: HubServerWebSocket, code?: number, reason?: string): void {
    ws.data.adapter?.dispatchClose(code, reason);
  }

  handleUplinkDrain(ws: HubServerWebSocket): void {
    ws.data.adapter?.dispatchDrain();
  }

  isUplinkSocket(ws: { data?: { kind?: string } }): boolean {
    return ws.data?.kind === HUB_UPLINK_WS_KIND;
  }

  private async withAuth(
    req: Request,
    handler: (auth: HubAuthResult) => Promise<Response> | Response
  ): Promise<Response> {
    const auth = await this.authenticate(req);
    if (!auth) return json({ error: 'unauthorized' }, 401);
    return handler(auth);
  }

  private handleListNodes(auth: HubAuthResult): Response {
    const nodes = this.userStore
      .listNodes()
      .filter((n) => n.userId === auth.userId)
      .map((n) => {
        const cert = this.userStore.getCert(n.id);
        const redeemed = parseStoredEnrollment(
          this.userStore.getEnrollmentTokenByNodeId(n.id)?.authorizationJson ?? ''
        );
        const certificate =
          redeemed?.certificate_b64 ?? (cert ? encodeBase64url(cert.certificateBytes) : undefined);
        const certSig =
          redeemed?.cert_sig_b64 ?? (cert ? encodeBase64url(cert.certSig) : undefined);
        return {
          id: n.id,
          name: n.name,
          status: n.status,
          online: Boolean(this.registry.get(n.id)?.authenticated),
          version: n.version,
          last_seen_at: n.lastSeenAt,
          direct_capable: n.directCapable,
          ...(certificate ? { certificate } : {}),
          ...(certSig ? { cert_sig: certSig } : {}),
        };
      });
    return json({ nodes });
  }

  private handleGetEnrollment(id: string, auth: HubAuthResult): Response {
    const token = this.userStore.getEnrollmentTokenById(id);
    if (!token || token.userId !== auth.userId) return json({ error: 'not_found' }, 404);
    const stored = parseStoredEnrollment(token.authorizationJson);
    const redeemed = token.usedAt !== null;
    const body: Record<string, unknown> = {
      status: redeemed ? 'redeemed' : 'pending',
      enroll_pk: encodeBase64url(token.enrollPublicKey),
      already_admitted: false,
    };
    if (!redeemed) return json(body);
    const nodeId = stored?.node_id ?? token.nodeId;
    if (nodeId) body.node_id = nodeId;
    const admitted = nodeId ? this.userStore.getCert(nodeId) : null;
    const alreadyAdmitted = admitted?.revokedLogSeq === null;
    body.already_admitted = alreadyAdmitted;
    if (alreadyAdmitted && admitted) {
      body.certificate = encodeBase64url(admitted.certificateBytes);
      body.cert_sig = encodeBase64url(admitted.certSig);
    } else {
      body.certificate = stored?.certificate_b64;
      body.cert_sig = stored?.cert_sig_b64;
    }
    return json(body);
  }

  private async handleRename(req: Request, nodeId: string, auth: HubAuthResult): Promise<Response> {
    const body = await readJsonObjectBody(req);
    const name = body?.name;
    if (typeof name !== 'string' || !name.trim()) return json({ error: 'invalid_name' }, 400);
    const next = name.trim();
    const node = this.userStore.getNode(nodeId);
    if (!node || node.userId !== auth.userId) return json({ error: 'not_found' }, 404);
    patchNode(this.db, nodeId, { name: next });
    this.registry.updateMeta(nodeId, { name: next }, this.now());
    await this.uplink.broadcastNodeList(auth.userId);
    return json({ ok: true, id: nodeId, name: next });
  }

  private async handleRevoke(req: Request, nodeId: string, auth: HubAuthResult): Promise<Response> {
    const cert = this.userStore.getCert(nodeId);
    if (!cert || cert.userId !== auth.userId) {
      return json({ error: 'not_found' }, 404);
    }
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'invalid_body' }, 400);
    let bytes: Uint8Array;
    let sig: Uint8Array;
    try {
      bytes = requireB64url(body, 'bytes');
      sig = requireB64url(body, 'sig', 64);
    } catch (err) {
      return validationError(err);
    }
    let record: ReturnType<typeof decodeKeyLogRecord>;
    try {
      record = decodeKeyLogRecord(bytes);
    } catch {
      return json({ error: 'bad_record' }, 400);
    }
    if (record.type !== 'revoke-node') return json({ error: 'not_revoke_node' }, 400);
    let payload: ReturnType<typeof decodeRevokeNodePayload>;
    try {
      payload = decodeRevokeNodePayload(record.payload);
    } catch {
      return json({ error: 'bad_payload' }, 400);
    }
    if (nodeIdToHex(payload.node_id) !== nodeId) return json({ error: 'node_mismatch' }, 400);
    const result = await this.keyLogSource.append(auth.userId, { bytes, sig });
    if (!result.ok) return json({ error: result.error }, 400);
    await this.uplink.applyAppendEffects(auth.userId, result);
    return json({ ok: true, id: nodeId, status: 'revoked' });
  }

  private async handleCreateEnrollment(req: Request, auth: HubAuthResult): Promise<Response> {
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'invalid_body' }, 400);
    const user = this.userStore.getById(auth.userId);
    if (!user) return json({ error: 'user_not_found' }, 404);
    let enrollPk: Uint8Array;
    let authorizationBytes: Uint8Array;
    let authorizationSig: Uint8Array;
    try {
      enrollPk = requireB64url(body, 'enroll_pk', 32);
      authorizationBytes = requireB64url(body, 'authorization');
      authorizationSig = requireB64url(body, 'authorization_sig');
    } catch (err) {
      return validationError(err);
    }
    let authorization: ReturnType<typeof decodeAuthorization>;
    try {
      authorization = decodeAuthorization(authorizationBytes);
    } catch {
      return json({ error: 'bad_authorization' }, 400);
    }
    const authErr = await this.verifyEnrollmentAuthorization(
      user,
      enrollPk,
      authorizationBytes,
      authorizationSig,
      authorization
    );
    if (authErr) return json({ error: authErr }, 400);
    const now = this.now();
    const authExp = Number(authorization.exp);
    const bodyExp = typeof body.exp === 'number' ? body.exp : authExp;
    const expiresAt = Math.min(authExp, bodyExp);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return json({ error: 'expired' }, 400);
    if (this.userStore.getEnrollmentTokenByEnrollPublicKey(enrollPk)) {
      return json({ error: 'duplicate_enroll_pk' }, 409);
    }
    const payload: StoredEnrollmentPayload = {
      authorization_b64: encodeBase64url(authorizationBytes),
      entry_node_id: auth.entryNodeId,
      ...(auth.sid && { entry_sid: auth.sid }),
    };
    const token = this.userStore.createEnrollmentToken({
      id: crypto.randomUUID(),
      userId: user.id,
      enrollPublicKey: enrollPk,
      authorizationJson: JSON.stringify(payload),
      authorizationSig,
      expiresAt,
    });
    const replicatedTo = await this.publishEnrollmentToken(token);
    const tls = (await this.tlsInfo?.()) ?? { caFingerprint: null, caPem: null };
    return json(
      {
        ok: true,
        id: token.id,
        expires_at: expiresAt,
        public_url: this.config.publicUrl,
        ca_fingerprint: tls.caFingerprint,
        ca_cert_pem: tls.caPem,
        replicatedTo,
      },
      201
    );
  }

  private async publishEnrollmentToken(
    token: ReturnType<UserStore['createEnrollmentToken']>
  ): Promise<string[]> {
    const revision = this.userStore.nextEnrollmentTokenRevision(this.uplink.writerEpoch());
    this.userStore.applyEnrollmentTokenReplication({ op: 'upsert', revision, token });
    return this.uplink.replicateEnrollmentTokens(
      upsertHubTokensMessage(token, revision, crypto.randomUUID()),
      HUB_TOKENS_ACK_WAIT_MS
    );
  }

  private async verifyEnrollmentAuthorization(
    user: UserRecord,
    enrollPk: Uint8Array,
    authorizationBytes: Uint8Array,
    authorizationSig: Uint8Array,
    authorization: ReturnType<typeof decodeAuthorization>
  ): Promise<string | null> {
    if (authorization.uid !== user.id) return 'uid_mismatch';
    if (authorization.root_epoch !== user.rootEpoch) return 'epoch_mismatch';
    if (!bytesEqual(authorization.enroll_pk, enrollPk)) return 'enroll_pk_mismatch';
    if (authorization.signer === 'root') {
      return authorizationSig.byteLength === 64 &&
        verifyEd25519(authorizationSig, authorizationBytes, user.rootPublicKey)
        ? null
        : 'bad_authorization_sig';
    }
    if (authorization.signer !== 'passkey') return 'bad_authorization';
    const credentialId = authorization.credential_id;
    if (!credentialId) return 'missing_credential_id';
    let credentialIdBytes: Uint8Array;
    try {
      credentialIdBytes = decodeBase64url(credentialId);
    } catch {
      return 'bad_authorization';
    }
    const storedKey = this.userStore.getKeyByCredentialId(credentialIdBytes);
    if (!storedKey || storedKey.userId !== user.id) return 'unknown_passkey';
    const ok = await makeVerifyPasskeyAssertion(this.userStore)({
      recordBytes: authorizationBytes,
      sig: authorizationSig,
      credentialId,
      publicKey: storedKey.publicKey,
      challenge: sha256(authorizationBytes),
    });
    return ok ? null : 'bad_authorization_sig';
  }

  private async handleRedeem(req: Request): Promise<Response> {
    const body = await readJsonObjectBody(req);
    if (!body) return json({ error: 'invalid_body' }, 400);
    let parsed: ReturnType<typeof parseRedeemRequest>;
    try {
      parsed = parseRedeemRequest(body, this.userStore);
    } catch (err) {
      return redeemCatch(err, true);
    }
    try {
      return await this.finishRedeem(parsed, body);
    } catch (err) {
      return redeemCatch(err, false);
    }
  }

  private async finishRedeem(
    parsed: ReturnType<typeof parseRedeemRequest>,
    body: Record<string, unknown>
  ): Promise<Response> {
    const { hexId, token, stored, providedName, version, certBytes, certSig, certificate } = parsed;
    const now = this.now();
    let replayUserId: string | null = null;
    let replacedExisting = false;
    let alreadyAdmitted = false;
    try {
      this.db.transaction((tx) => {
        ({ replacedExisting, alreadyAdmitted } = redeemInTransaction(
          tx as AuthDb,
          parsed,
          body,
          now
        ));
      });
    } catch (err) {
      if (!(err instanceof RedeemReplay)) throw err;
      replayUserId = err.userId;
    }
    if (replacedExisting) this.registry.updateMeta(hexId, nameVersion(providedName, version), now);
    if (!replayUserId && stored.entry_node_id) {
      const admitted = alreadyAdmitted ? this.userStore.getCert(hexId) : null;
      this.uplink.sendTo(stored.entry_node_id, {
        t: 'enroll.redeemed',
        certificate: encodeBase64url(admitted ? admitted.certificateBytes : certBytes),
        cert_sig: encodeBase64url(admitted ? admitted.certSig : certSig),
        enroll_pk: encodeBase64url(certificate.enroll_pk),
        node_id: hexId,
        already_admitted: alreadyAdmitted,
        ...(stored.entry_sid && { entry_sid: stored.entry_sid }),
      });
    }
    if (replacedExisting) await this.uplink.broadcastNodeList(token.userId);
    const consumed = this.userStore.getEnrollmentTokenById(token.id);
    if (consumed) void this.publishEnrollmentToken(consumed);
    if (replayUserId) alreadyAdmitted = this.userStore.getCert(hexId)?.revokedLogSeq === null;
    if (alreadyAdmitted) console.info(`[hub] already admitted node=${hexId}`);
    return this.redeemSuccessPayload(replayUserId ?? token.userId, alreadyAdmitted);
  }

  private async redeemSuccessPayload(userId: string, alreadyAdmitted: boolean): Promise<Response> {
    const user = this.userStore.getById(userId);
    if (!user) return json({ error: 'user_not_found' }, 500);
    const records = await this.keyLogSource.list(user.id);
    const certs = this.userStore.listCerts().filter((c) => c.userId === user.id);
    return json({
      user: {
        id: user.id,
        username: user.username,
        root_public_key: encodeBase64url(user.rootPublicKey),
        root_epoch: user.rootEpoch,
        kdf_params: parseKdfParams(user.kdfParamsJson),
      },
      user_key_log: records.map((r) => ({
        seq: Number(r.seq) <= Number.MAX_SAFE_INTEGER ? Number(r.seq) : r.seq.toString(),
        bytes: encodeBase64url(r.bytes),
        sig: encodeBase64url(r.sig),
      })),
      node_certs: certs.map((c) => ({
        node_id: c.nodeId,
        user_id: c.userId,
        admit_record_seq: c.admitRecordSeq,
        certificate: encodeBase64url(c.certificateBytes),
        cert_sig: encodeBase64url(c.certSig),
        authorization: encodeBase64url(c.authorizationBytes),
        authorization_sig: encodeBase64url(c.authorizationSig),
        revoked_log_seq: c.revokedLogSeq,
      })),
      already_admitted: alreadyAdmitted,
    });
  }
}

class RedeemAbort extends Error {
  constructor(
    readonly error: string,
    readonly status: number
  ) {
    super(error);
    this.name = 'RedeemAbort';
  }
}

class RedeemReplay extends Error {
  constructor(readonly userId: string) {
    super('redeem-replay');
    this.name = 'RedeemReplay';
  }
}

function redeemCatch(err: unknown, parsePhase: boolean): Response {
  if (err instanceof RedeemAbort) return json({ error: err.error }, err.status);
  if (parsePhase) return validationError(err);
  throw err;
}

function abortRedeem(cond: boolean, error: string, status = 400): asserts cond is false {
  if (cond) throw new RedeemAbort(error, status);
}

function decodeOrAbort<T>(fn: () => T, error: string): T {
  try {
    return fn();
  } catch {
    throw new RedeemAbort(error, 400);
  }
}

function nameVersion(
  name: string | null,
  version: string | null
): { name?: string; version?: string } {
  return { ...(name && { name }), ...(version && { version }) };
}

function parseRedeemRequest(body: Record<string, unknown>, userStore: UserStore) {
  const providedName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
  const certBytes = requireB64url(body, 'certificate');
  const certSig = requireB64url(body, 'cert_sig', 64);
  const certificate = decodeOrAbort(() => decodeCertificate(certBytes), 'bad_certificate');
  const token = userStore.getEnrollmentTokenByEnrollPublicKey(certificate.enroll_pk);
  if (!token) throw new RedeemAbort('unknown_enrollment', 400);
  abortRedeem(!verifyNodeCertificate(certBytes, certSig, token.enrollPublicKey), 'bad_cert_sig');
  const stored = parseStoredEnrollment(token.authorizationJson);
  if (!stored) throw new RedeemAbort('bad_token', 400);
  const authorization = decodeOrAbort(
    () => decodeAuthorization(decodeB64url(stored.authorization_b64)),
    'bad_authorization'
  );
  abortRedeem(!bytesEqual(authorization.enroll_pk, certificate.enroll_pk), 'enroll_pk_mismatch');
  abortRedeem(
    authorization.uid !== certificate.uid || authorization.uid !== token.userId,
    'uid_mismatch'
  );
  return {
    name: providedName ?? 'node',
    version: typeof body.version === 'string' && body.version ? body.version : null,
    providedName,
    certBytes,
    certSig,
    certificate,
    token,
    stored,
    authorization,
    hexId: nodeIdToHex(certificate.node_id),
  };
}

function redeemInTransaction(
  authDb: AuthDb,
  parsed: ReturnType<typeof parseRedeemRequest>,
  body: Record<string, unknown>,
  now: number
): { replacedExisting: boolean; alreadyAdmitted: boolean } {
  const {
    certificate,
    certBytes,
    certSig,
    stored,
    authorization,
    hexId,
    name,
    version,
    providedName,
  } = parsed;
  const store = new UserStore(authDb);
  const fresh = store.getEnrollmentTokenByEnrollPublicKey(certificate.enroll_pk);
  if (!fresh) throw new RedeemAbort('unknown_enrollment', 400);
  if (fresh.usedAt !== null) {
    const prev = parseStoredEnrollment(fresh.authorizationJson);
    if (
      prev?.certificate_b64 === encodeBase64url(certBytes) &&
      prev?.cert_sig_b64 === encodeBase64url(certSig)
    ) {
      throw new RedeemReplay(fresh.userId);
    }
    throw new RedeemAbort('reused', 400);
  }
  const userRow = store.getById(fresh.userId);
  const existing = store.getNode(hexId);
  const existingCert = store.getCert(hexId);
  const keys = existing ? readNodeIdentityKeys(store, hexId) : null;
  abortRedeem(!userRow, 'user_not_found', 500);
  abortRedeem(authorization.root_epoch !== userRow?.rootEpoch, 'epoch_mismatch');
  abortRedeem(fresh.expiresAt <= now, 'expired');
  abortRedeem(
    Boolean(
      existing &&
        (existing.userId !== fresh.userId ||
          !keys ||
          !bytesEqual(keys.edPk, certificate.ed_pk) ||
          !bytesEqual(keys.x25519Pk, certificate.x25519_pk) ||
          !verifyRedeemPop(body, certificate, keys.edPk, certBytes))
    ),
    'node_exists',
    409
  );
  abortRedeem(
    existingCert?.revokedLogSeq != null || existing?.status === 'revoked',
    'node_revoked',
    409
  );
  if (existing) detachEnrollmentTokensFromNode(authDb, hexId);
  abortRedeem(
    !store.consumeEnrollmentToken(certificate.enroll_pk, {
      nodeId: hexId,
      now,
      authorizationJson: JSON.stringify({
        ...stored,
        certificate_b64: encodeBase64url(certBytes),
        cert_sig_b64: encodeBase64url(certSig),
        node_id: hexId,
      } satisfies StoredEnrollmentPayload),
    }),
    'reused'
  );
  if (existing) {
    patchNode(authDb, hexId, { status: 'enrolled', ...nameVersion(providedName, version) });
  } else {
    store.createNode({
      id: hexId,
      userId: fresh.userId,
      name,
      status: 'enrolled',
      version,
      now,
    });
  }
  return {
    replacedExisting: Boolean(existing),
    alreadyAdmitted: existingCert?.revokedLogSeq === null,
  };
}

function parseStoredEnrollment(raw: string): StoredEnrollmentPayload | null {
  try {
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rec = obj as Record<string, unknown>;
    if (typeof rec.authorization_b64 !== 'string') return null;
    const str = (key: string) => (typeof rec[key] === 'string' ? rec[key] : undefined);
    return {
      authorization_b64: rec.authorization_b64,
      entry_node_id: typeof rec.entry_node_id === 'string' ? rec.entry_node_id : null,
      entry_sid: str('entry_sid'),
      certificate_b64: str('certificate_b64'),
      cert_sig_b64: str('cert_sig_b64'),
      node_id: str('node_id'),
    };
  } catch {
    return null;
  }
}

function verifyRedeemPop(
  body: Record<string, unknown>,
  certificate: ReturnType<typeof decodeCertificate>,
  existingPk: Uint8Array,
  certBytes: Uint8Array
): boolean {
  if (typeof body.pop !== 'string') return false;
  try {
    return verifyEd25519(
      decodeB64url(body.pop, 64),
      encodeRedeemPopMessage({
        enrollmentId: encodeBase64url(certificate.enroll_pk),
        nodeId: certificate.node_id,
        certBytes,
      }),
      existingPk
    );
  } catch {
    return false;
  }
}

function readNodeIdentityKeys(
  store: UserStore,
  nodeId: string
): { edPk: Uint8Array; x25519Pk: Uint8Array } | null {
  const cert = store.getCert(nodeId);
  const fromCert = cert ? decodeCertificateIdentityKeys(cert.certificateBytes) : null;
  if (fromCert) return fromCert;
  const token = store.getEnrollmentTokenByNodeId(nodeId);
  const stored = parseStoredEnrollment(token?.authorizationJson ?? '');
  if (!stored?.certificate_b64) return null;
  try {
    return decodeCertificateIdentityKeys(decodeBase64url(stored.certificate_b64));
  } catch {
    return null;
  }
}
