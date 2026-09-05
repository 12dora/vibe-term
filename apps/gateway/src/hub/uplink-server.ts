import type { LinkSession, LinkStream } from '@tmex/shared/link';
import {
  HUB_NOT_WRITER,
  type HubAdvertisement,
  type HubAttachmentsMessage,
  type HubForwardMessage,
  type HubMode,
  type HubNotWriterError,
  type HubWriteForwardMessage,
} from '@tmex/shared/uplink';
import { MeshHubStore, pickWriterHub } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import type { UserStore } from '../auth/user-store';
import { ATTACHMENT_KEEPALIVE_MS, AttachmentRouter } from './attachment-router';
import {
  applyKeyLogHubRuntime,
  lookupSignedHubAuthorization,
  isAuthorizedHub as mergeAuthorizedHub,
  resolveMeshUserId,
} from './hub-authorization';
import { HubFederation, type HubFederationOptions, resolveStartMode } from './hub-federation';
import { HubRelayStreams } from './hub-relay-streams';
import type { NodeRegistry } from './node-registry';
import {
  HUB_AUTH_TIMEOUT_MS,
  HUB_HEARTBEAT_INTERVAL_MS,
  HUB_HEARTBEAT_MISS_LIMIT,
  HUB_RTC_MAX_SESSIONS,
  type HubKeyLogAppendSuccess,
  type HubKeyLogSource,
  type HubRuntimeConfig,
} from './types';
import { UplinkAuthSession } from './uplink-auth-session';
import { UplinkKeyLog, type UplinkKeyLogOptions } from './uplink-key-log';
import { UplinkNodeList } from './uplink-node-list';
import { type HubTokensMessage, type UplinkCtlMessage, decodeUplinkCtl } from './uplink-protocol';
import { HUB_KEY_LOG_REQ_IDLE_TTL_MS, HUB_KEY_LOG_REQ_STATE_MAX } from './uplink-rate-limit';
import { type RegisterRtcSessionInput, UplinkRtcSessions } from './uplink-rtc-sessions';
import {
  type OwnHubSnapshot,
  type UplinkServerState,
  createUplinkServerState,
} from './uplink-server-state';

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
export {
  HUB_CTL_QUEUE_MAX,
  HUB_CTL_QUEUE_MAX_BYTES,
  HUB_STOP_DRAIN_TIMEOUT_MS,
  HUB_UPLINK_AUTH_REJECT_LOG_ADDR_MAX,
  HUB_UPLINK_AUTH_REJECT_LOG_GLOBAL_MAX,
  HUB_UPLINK_AUTH_REJECT_LOG_INTERVAL_MS,
} from './uplink-auth-session';
export { HUB_KEY_LOG_REQ_LOG_INTERVAL_MS } from './uplink-key-log';
export {
  HUB_SPLIT_BRAIN_LOG_INTERVAL_MS,
  HUB_UNAUTHORIZED_HUB_AD_LOG_INTERVAL_MS,
} from './hub-federation';
export type {
  RegisterRtcSessionInput,
  RtcSessionRegistration,
} from './uplink-rtc-sessions';

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
  attachmentKeepaliveMs?: number;
  rtcMaxSessions?: number;
  keyLogReqStateMax?: number;
  keyLogReqIdleTtlMs?: number;
  meshHubs?: MeshHubStore;
  onModeChange?: () => void;
  onNewAuthorizedHub?: (hubNodeId: string) => void;
  forwardAppend?: UplinkKeyLogOptions['forwardAppend'];
  onForwardedWrite?: () => void;
  openHubStream?: (hubId: string, payload: Uint8Array) => Promise<LinkStream | null>;
  forwardHubCtl?: (msg: HubAttachmentsMessage | HubForwardMessage) => void;
  onWriteForward?: HubFederationOptions['onWriteForward'];
};

const HUB_NODE_ID_HEX = /^[0-9a-f]{32}$/i;

export class UplinkServer {
  private readonly userStore: UserStore;
  readonly registry: NodeRegistry;
  readonly meshHubs: MeshHubStore;
  private readonly config: HubRuntimeConfig;
  private currentMode: HubMode;
  private readonly hubPriority: number;
  private hubWriterEpoch: number;
  private readonly authorizedHubIdSet: Set<string>;
  private selfCaFingerprint: string | null = null;
  private readonly onModeChange?: () => void;
  readonly attachments: AttachmentRouter;
  private readonly now: () => number;
  private readonly state: UplinkServerState;
  private readonly authSession: UplinkAuthSession;
  private readonly rtc: UplinkRtcSessions;
  private readonly relayStreams: HubRelayStreams;
  private readonly federation: HubFederation;
  private readonly nodeList: UplinkNodeList;
  private readonly keyLog: UplinkKeyLog;
  private readonly lastNodeListFp: Map<string, string>;
  private readonly lastNodeListSent: Map<string, Uint8Array>;

  constructor(opts: UplinkServerOptions) {
    this.userStore = opts.userStore;
    this.registry = opts.registry;
    this.meshHubs = opts.meshHubs ?? new MeshHubStore(opts.db);
    this.config = opts.config;
    this.hubWriterEpoch = opts.config.writerEpoch ?? 1;
    const configMode = opts.config.mode ?? 'active';
    this.hubPriority = opts.config.priority ?? (configMode === 'standby' ? 200 : 100);
    this.authorizedHubIdSet = new Set(
      (opts.config.authorizedHubIds ?? [])
        .map((id) => id.trim().toLowerCase())
        .filter((id) => HUB_NODE_ID_HEX.test(id))
    );
    const ownId = this.hubNodeId();
    const existingOwn = ownId ? this.meshHubs.get(ownId) : null;
    this.selfCaFingerprint = existingOwn?.caFingerprint ?? null;
    this.currentMode = this.effectiveStartMode(configMode);
    this.onModeChange = opts.onModeChange;
    this.now = opts.now ?? Date.now;
    this.attachments = new AttachmentRouter({
      selfHubId: () => this.hubNodeId(),
      now: this.now,
    });
    const logStateMax = opts.keyLogReqStateMax ?? HUB_KEY_LOG_REQ_STATE_MAX;
    const logIdleTtlMs = opts.keyLogReqIdleTtlMs ?? HUB_KEY_LOG_REQ_IDLE_TTL_MS;
    this.state = createUplinkServerState({
      attachments: this.attachments,
      logStateMax,
      logIdleTtlMs,
    });
    this.lastNodeListFp = this.state.lastNodeListFp;
    this.lastNodeListSent = this.state.lastNodeListSent;
    this.authSession = new UplinkAuthSession({
      state: this.state,
      db: opts.db,
      userStore: opts.userStore,
      registry: opts.registry,
      meshHubs: this.meshHubs,
      config: opts.config,
      now: this.now,
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS,
      heartbeatMissLimit: opts.heartbeatMissLimit ?? HUB_HEARTBEAT_MISS_LIMIT,
      authTimeoutMs: opts.authTimeoutMs ?? HUB_AUTH_TIMEOUT_MS,
      logStateMax,
      logIdleTtlMs,
      deps: {
        hubNodeId: () => this.hubNodeId(),
        isAuthorizedHub: (id, userId) => this.isAuthorizedHub(id, userId),
        onCtl: (link, bytes) => this.onCtl(link, bytes),
        onIncomingStream: (link, stream) => this.onIncomingStream(link, stream),
        broadcastNodeList: (userId) => this.nodeList.broadcastNodeList(userId),
        noteLocalAttach: (nodeId) => this.federation.noteLocalAttach(nodeId),
        noteLocalDetach: (nodeId, dropAsHub) => this.federation.noteLocalDetach(nodeId, dropAsHub),
        dropRtcForNode: (nodeId) => this.rtc.dropRtcForNode(nodeId),
      },
    });
    this.rtc = new UplinkRtcSessions({
      userStore: opts.userStore,
      registry: opts.registry,
      now: this.now,
      rtcMaxSessions: opts.rtcMaxSessions ?? HUB_RTC_MAX_SESSIONS,
      deps: {
        send: (link, msg) => this.authSession.send(link, msg),
        forwardRtcAcrossHubs: (live, msg) => this.federation.forwardRtcAcrossHubs(live, msg),
      },
    });
    this.relayStreams = new HubRelayStreams({
      state: this.state,
      userStore: opts.userStore,
      registry: opts.registry,
      openHubStream: opts.openHubStream,
      deps: {
        hubNodeId: () => this.hubNodeId(),
        isWriter: () => this.isWriter(),
        isAuthorizedHub: (id, userId) => this.isAuthorizedHub(id, userId),
      },
    });
    this.federation = new HubFederation({
      state: this.state,
      userStore: opts.userStore,
      registry: opts.registry,
      meshHubs: this.meshHubs,
      now: this.now,
      attachmentKeepaliveMs:
        opts.attachmentKeepaliveMs === undefined
          ? ATTACHMENT_KEEPALIVE_MS
          : opts.attachmentKeepaliveMs,
      forwardHubCtl: opts.forwardHubCtl,
      onWriteForward: opts.onWriteForward,
      deps: {
        hubNodeId: () => this.hubNodeId(),
        isWriter: () => this.isWriter(),
        isAuthorizedHub: (id, userId) => this.isAuthorizedHub(id, userId),
        mode: () => this.currentMode,
        writerEpoch: () => this.hubWriterEpoch,
        setMode: (mode) => this.setMode(mode),
        notWriterError: () => this.notWriterError(),
        authorizedHubRecords: () => this.authorizedHubRecords(),
        send: (link, msg) => this.authSession.send(link, msg),
        broadcastAllNodeLists: () => this.nodeList.broadcastAllNodeLists(),
        resetCrossHubRelays: (hubId) => this.relayStreams.resetCrossHubRelays(hubId),
        onNewAuthorizedHub: opts.onNewAuthorizedHub,
      },
    });
    this.nodeList = new UplinkNodeList({
      state: this.state,
      db: opts.db,
      userStore: opts.userStore,
      registry: opts.registry,
      meshHubs: this.meshHubs,
      keyLogSource: opts.keyLogSource,
      config: opts.config,
      now: this.now,
      deps: {
        hubNodeId: () => this.hubNodeId(),
        isWriter: () => this.isWriter(),
        isAuthorizedHub: (id, userId) => this.isAuthorizedHub(id, userId),
        authorizedHubRecords: () => this.authorizedHubRecords(),
        sendBytes: (link, bytes) => this.authSession.sendBytes(link, bytes),
        assertLiveCert: (live) => this.authSession.assertLiveCert(live),
        applyAuthorizedHubAdvertisement: (hubNodeId, ad, source) =>
          this.federation.applyAuthorizedHubAdvertisement(hubNodeId, ad, source),
        sendTokenSnapshotOnce: (live) => this.federation.sendTokenSnapshotOnce(live),
      },
    });
    this.keyLog = new UplinkKeyLog({
      state: this.state,
      userStore: opts.userStore,
      registry: opts.registry,
      keyLogSource: opts.keyLogSource,
      now: this.now,
      forwardAppend: opts.forwardAppend,
      onForwardedWrite: opts.onForwardedWrite,
      deps: {
        hubNodeId: () => this.hubNodeId(),
        isWriter: () => this.isWriter(),
        notWriterError: () => this.notWriterError(),
        send: (link, msg) => this.authSession.send(link, msg),
        broadcastNodeList: (userId) => this.nodeList.broadcastNodeList(userId),
        certIsRevoked: (nodeId) => this.authSession.certIsRevoked(nodeId),
        evictRevokedNode: (nodeId) => this.authSession.evictRevokedNode(nodeId),
        applyHubAuthorizationRecord: (userId, record) =>
          this.applyHubAuthorizationRecord(userId, record),
      },
    });
    if (opts.config.nodeId) {
      this.userStore.upsertHubMeta({
        nodeId: opts.config.nodeId,
        publicUrl: opts.config.publicUrl,
        now: this.now(),
      });
    }
    this.upsertSelfHub();
    this.federation.startAttachmentKeepalive();
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

  isWriter(): boolean {
    if (this.currentMode !== 'active') return false;
    const own = this.hubNodeId();
    const writer = pickWriterHub(this.authorizedHubRecords());
    if (!own) return writer === null;
    return writer === own;
  }

  ownHubSnapshot(): OwnHubSnapshot | null {
    const hubNodeId = this.hubNodeId();
    if (!hubNodeId) return null;
    return {
      hubNodeId,
      publicUrl: this.config.publicUrl,
      name: this.nodeList.nodeDisplayName(hubNodeId),
      mode: this.currentMode,
      priority: this.hubPriority,
      writerEpoch: this.hubWriterEpoch,
      caFingerprint: this.selfCaFingerprint,
      online: true,
      lastSeenAt: this.now(),
    };
  }

  updateSelfCaFingerprint(fp: string | null): void {
    const next = fp ?? null;
    if (this.selfCaFingerprint === next) return;
    this.selfCaFingerprint = next;
    this.upsertSelfHub();
  }

  setMode(mode: HubMode): void {
    this.applyLocalRole(mode);
  }

  setWriterEpoch(epoch: number): void {
    this.applyLocalRole(this.currentMode, epoch);
  }

  applyLocalRole(mode: HubMode, writerEpoch?: number): void {
    const nextEpoch = writerEpoch ?? this.hubWriterEpoch;
    if (this.currentMode === mode && this.hubWriterEpoch === nextEpoch) return;
    this.currentMode = mode;
    this.hubWriterEpoch = nextEpoch;
    this.upsertSelfHub();
    this.broadcastAllNodeLists();
    this.onModeChange?.();
  }

  notWriterError(): HubNotWriterError {
    const writerId = pickWriterHub(this.authorizedHubRecords());
    const writer = writerId ? this.meshHubs.get(writerId) : null;
    return {
      code: HUB_NOT_WRITER,
      writerHubId: writerId,
      writerPublicUrl: writer?.publicUrl ?? null,
      writerEpoch: writer?.writerEpoch ?? null,
    };
  }

  private upsertSelfHub(): void {
    const snapshot = this.ownHubSnapshot();
    if (!snapshot) return;
    if (!this.isAuthorizedHub(snapshot.hubNodeId)) {
      this.meshHubs.remove(snapshot.hubNodeId);
      return;
    }
    this.meshHubs.upsert(snapshot, this.now());
  }

  private authorizedHubRecords() {
    return this.meshHubs.list().filter((row) => this.isAuthorizedHub(row.hubNodeId));
  }

  isAuthorizedHub(nodeId: string, userId?: string | null): boolean {
    const uid = userId ?? this.meshUserId();
    return mergeAuthorizedHub({
      hubNodeId: nodeId,
      selfId: this.hubNodeId(),
      envPeers: this.authorizedHubIdSet,
      signed: lookupSignedHubAuthorization(this.userStore, uid, nodeId),
    });
  }

  meshUserId(): string | null {
    return resolveMeshUserId(this.userStore, { nodeId: this.hubNodeId() ?? this.config.nodeId });
  }

  applyHubAuthorizationRecord(userId: string, record: { type: string; payload: Uint8Array }): void {
    applyKeyLogHubRuntime(this.meshHubs, record, {
      selfId: this.hubNodeId(),
      now: this.now(),
      onRetireSelf: () => this.setMode('standby'),
    });
    const own = this.hubNodeId();
    if (own && !this.isAuthorizedHub(own, userId)) {
      this.meshHubs.remove(own);
      if (this.currentMode === 'active') this.setMode('standby');
    }
    this.broadcastAllNodeLists();
  }

  private effectiveStartMode(configMode: HubMode): HubMode {
    return resolveStartMode({
      configMode,
      ownId: this.hubNodeId(),
      writerEpoch: this.hubWriterEpoch,
      hubs: this.meshHubs.list(),
      isAuthorizedHub: (id) => this.isAuthorizedHub(id),
    });
  }

  private async onCtl(link: LinkSession, bytes: Uint8Array): Promise<void> {
    if (this.state.stopped || !this.state.accepted.has(link)) return;
    let msg: UplinkCtlMessage;
    try {
      msg = decodeUplinkCtl(bytes);
    } catch {
      link.close('protocol_error');
      return;
    }
    const live = this.state.live.get(link);
    if (!live) {
      if (msg.t !== 'auth.response') {
        this.authSession.rejectAuth(link, undefined, 'unauthenticated', 'unauthenticated');
        return;
      }
      await this.authSession.handleAuthResponse(link, msg.node_id, msg.sig);
      return;
    }
    if (!this.authSession.assertLiveCert(live)) return;
    this.registry.touch(live.nodeId, this.now());
    switch (msg.t) {
      case 'ping':
        this.authSession.send(link, { t: 'pong' });
        return;
      case 'pong':
        if (live.awaitingPong) {
          live.awaitingPong = false;
          live.misses = 0;
        }
        if (this.isAuthorizedHub(live.nodeId, live.userId)) {
          this.attachments.refreshHub(live.nodeId);
        }
        return;
      case 'node.status':
        await this.nodeList.handleNodeStatus(live, msg);
        return;
      case 'key.log.req':
        await this.keyLog.handleKeyLogReq(live, msg);
        return;
      case 'key.log.append':
        await this.keyLog.handleKeyLogAppend(live, msg.bytes, msg.sig, msg.id, msg.force === true);
        return;
      case 'rtc.signal':
        this.rtc.handleRtcSignal(live, msg);
        return;
      case 'hub.tokens':
        this.federation.handleHubTokens(live, msg);
        return;
      case 'hub.attachments':
        this.federation.handleHubAttachments(live, msg);
        return;
      case 'hub.forward':
        this.federation.handleHubForward(live, msg);
        return;
      case 'hub.write-forward':
        await this.federation.handleHubWriteForward(live, msg);
        return;
      case 'key.log.res':
        link.close('protocol_error');
        return;
      default:
        return;
    }
  }

  private async onIncomingStream(link: LinkSession, stream: LinkStream): Promise<void> {
    const live = this.state.live.get(link);
    if (!live) {
      stream.reset('unauthenticated');
      return;
    }
    if (!this.authSession.assertLiveCert(live)) {
      stream.reset('revoked');
      return;
    }
    await this.relayStreams.routeNodeStream(live, stream);
  }

  async stop(): Promise<void> {
    this.state.stopped = true;
    this.federation.clearAttachmentKeepalive();
    const links = [...this.state.accepted];
    for (const live of this.state.live.values()) {
      this.authSession.clearHeartbeat(live);
    }
    this.state.live.clear();
    for (const link of links) {
      this.authSession.clearAuthTimer(link);
      link.close('hub-stop');
    }
    this.state.accepted.clear();
    this.state.authTimers.clear();
    this.rtc.clear();
    this.relayStreams.resetCrossHubRelays();
    this.lastNodeListFp.clear();
    this.lastNodeListSent.clear();
    this.state.keyLogReqLimiter.clear();
    this.state.keyLogReqLogs.clear();
    this.authSession.clearAuthRejectLogs();
    this.registry.closeAll('hub-stop');
    await this.authSession.drainInflight();
    this.state.timers.dispose(); // 兜底：登记过的定时器一次清干净，之后再也挂不上新的
  }

  get pendingTimerCount(): number {
    return this.state.timers.size;
  }

  get keyLogReqBucketCount(): number {
    return this.state.keyLogReqLimiter.primarySize;
  }

  accept(link: LinkSession, opts?: { remoteAddress?: string }): void {
    this.authSession.accept(link, opts);
  }

  sendTo(nodeId: string, msg: UplinkCtlMessage): boolean {
    return this.authSession.sendTo(nodeId, msg);
  }

  disconnect(nodeId: string, reason = 'disconnected'): boolean {
    return this.authSession.disconnect(nodeId, reason);
  }

  broadcastAllNodeLists(): void {
    this.nodeList.broadcastAllNodeLists();
  }

  broadcastNodeList(userId: string): Promise<'sent' | 'unchanged' | 'failed'> {
    return this.nodeList.broadcastNodeList(userId);
  }

  registerRtcSession(input: RegisterRtcSessionInput): string | null {
    return this.rtc.registerRtcSession(input);
  }

  unregisterRtcSession(rtcSession: string): void {
    this.rtc.unregisterRtcSession(rtcSession);
  }

  ensureDcSession(userId: string, nodeA: string, nodeB: string): boolean {
    return this.rtc.ensureDcSession(userId, nodeA, nodeB);
  }

  applyAppendEffects(userId: string, result: HubKeyLogAppendSuccess): Promise<void> {
    return this.keyLog.applyAppendEffects(userId, result);
  }

  replicateEnrollmentTokens(msg: HubTokensMessage, waitMs?: number): Promise<string[]> {
    return this.federation.replicateEnrollmentTokens(msg, waitMs);
  }

  publishLocalAttachments(): void {
    this.federation.publishLocalAttachments();
  }

  ingestHubAttachments(fromHubId: string, msg: HubAttachmentsMessage): void {
    this.federation.ingestHubAttachments(fromHubId, msg);
  }

  ingestHubForward(fromHubId: string, msg: HubForwardMessage): void {
    this.federation.ingestHubForward(fromHubId, msg);
  }

  ingestHubRelay(fromHubId: string, stream: LinkStream): void {
    this.relayStreams.ingestHubRelay(fromHubId, stream);
  }

  resetCrossHubRelays(hubId?: string): void {
    this.relayStreams.resetCrossHubRelays(hubId);
  }

  applyAuthorizedHubAdvertisement(
    hubNodeId: string,
    ad: HubAdvertisement,
    source: 'uplink' | 'peer-status' = 'uplink'
  ): void {
    this.federation.applyAuthorizedHubAdvertisement(hubNodeId, ad, source);
  }
}
