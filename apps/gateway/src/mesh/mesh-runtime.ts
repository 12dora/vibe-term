import os from 'node:os';
import { canonicalHubUrl, encodeBase64url } from '@vibeterm/shared/auth';
import { createInMemoryLinkPair } from '@vibeterm/shared/link';
import type { StunEnvSource } from '@vibeterm/shared/net';
import type { HubAdvertisement, HubMode } from '@vibeterm/shared/uplink';
import { notifyNodeOffline } from '../agent/node-offline-bus';
import { dropPaneGrantsOfNode } from '../agent/pane-grant/revoke';
import { filesBulkHooks } from '../api/files';
import {
  ChallengeStore,
  KeyLogStore,
  type NodeIdentityKeys,
  NodeIdentityStore,
  NodeSessionStore,
  UserKeyService,
  UserStore,
  ensureNodeIdentity,
  makeDeferredVerifyPasskeyAssertion,
} from '../auth';
import { HubTrustStore } from '../auth/hub-trust-store';
import { MeshHubStore } from '../auth/mesh-hub-store';
import type { AuthDb } from '../auth/types';
import { type VibeTermRoles, config as gatewayConfig } from '../config';
import { getSiteSettings } from '../db/site-settings';
import { HubRuntime, type HubTurnConfig } from '../hub';
import {
  envPeerSet,
  isAuthorizedHub,
  lookupSignedHubAuthorization,
  resolveMeshUserId,
} from '../hub/hub-authorization';
import { createHubKeyLogSource } from '../hub/hub-key-log-source';
import type { HubPeerFetch } from '../hub/hub-peer-poller';
import type { HubTlsInfoProvider } from '../hub/hub-runtime';
import { setMessagingMeshRuntime } from '../messaging/runtime-hooks';
import { bindPortMapNode } from '../portmap/binding';
import { PortMapExportStore } from '../portmap/store';
import type { GatewayRuntime } from '../runtime';
import { getDisplayVersion } from '../system/version';
import { setTransferMeshBridge, wireTransferBridge } from '../transfer/bridge';
import type { GatewaySession } from '../ws/gateway-session';
import { openAdaptedWsStream } from './adapted-ws-stream';
import {
  hasLocalCgnatAddress,
  isCgnatIpv4,
  isFakeIpv4,
  isPeerReachable,
  parseIpv6Words,
} from './address-class';
import { defaultScheduler, encodeJsonBytes } from './ctl';
import { bindKeyLogProjection } from './key-log-projection';
import { lookupRemoteNode, setMeshAgentBridge } from './mesh-agent-bridge';
import {
  type CachedRtcConfig,
  type ConnectionLookupResult,
  type KeyLogPublisher,
  MESH_VIA_SELF,
  type MeshHandleResult,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type NodeEventPayload,
  type PeerLinkGetOpts,
  type RtcFingerprintProvider,
  type RtcSignalMessage,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  getMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { applyInboundDispatchContext } from './mesh-inbound-dispatch';
import { stamp } from './mesh-log';
import {
  HUB_PRESENCE_STALE_MS,
  clearHubPresenceDecay,
  listHubOnlineIds,
  scheduleHubPresenceDecay,
  setHubPresenceStaleMs,
} from './mesh-presence-decay';
import { dispatchUplinkRtcSignal, sendRtcOverUplink } from './mesh-rtc-dispatch';
import {
  type RegisterGatewaySessionInput,
  type RegisterGatewaySessionResult,
  type RegisteredGatewaySession,
  SessionRegistry,
} from './mesh-session-registry';
import { meshStopTasksFor } from './mesh-stop-tasks';
import { NodeEventDedupe, type NodeEventProjection } from './node-event-dedupe';
import {
  STATUS_IFACE_CACHE_TTL_MS,
  applyUplinkNodeList,
  attachKeyLogHeadNotify,
  createTtlCache,
  meshHubNotRetired,
} from './node-list-apply';
import { pickSelfDisplayName } from './node-list-projection';
import { buildMeshNotificationBridge } from './notification-bridge-wiring';
import { setMeshNotificationBridge } from './notification-mesh-bridge';
import { listNotificationSinkNodeIds } from './notification-sink-records';
import { type PeerLinkFactory, PeerManager } from './peer-manager';
import { bootPortReach, notePeerTransport, peerReachPayload } from './port-reach';
import { installRelayMultiAttach, primaryNodeListApplyPatch } from './relay-multi-attach';
import type { RelayPresenceIndex, RelayStreamOpener } from './relay-presence-types';
import { RelayUplinkClient } from './relay-uplink-client';
import {
  bindRelayReconcile,
  bindRelayUplinkFactory,
  createRelayRoutes,
  createRelayWiring,
  reconfigureRelayUplink,
  relayMultiAttachOf,
  relayUplinkOverrides,
} from './relay-wiring';
import {
  type ControlSendStatus,
  type LoadNative,
  MeshRtcSignalRouter,
  RtcPeerManager,
} from './rtc';
import { BulkTransferService, parseBulkChannelLabel } from './rtc/bulk';
// biome-ignore format: mesh-runtime fileLines allowlist
import {
  meshRtcConfigResponse, noteMeshStunConfig, resolveMeshRtcConfig,
  startMeshRtcProbes, stopMeshRtcProbes, syncMeshRtcProbes, turnFromMesh,
} from './rtc/stun-effective';
import { authenticateRequest } from './session-middleware';
import { sessionVerifyDeadline, sessionVerifyDue } from './session-verify-window';
import { openHttpStream } from './stream-targets';
import type {
  DispatchContext,
  KeyLogApplier,
  MeshScheduler,
  PeerBindHost,
  PeerReach,
} from './types';
import { UplinkClient, type UplinkWsFactory } from './uplink-client';
import {
  type AttachedHub,
  type UplinkCandidate,
  UplinkPool,
  attachedHubHost,
  defaultProbeHealthz,
  isSelfHubCandidate,
  mergeUplinkCandidates,
  sameHubUrl,
} from './uplink-pool';
import { bindHubUplinkHooks, kickHubPeerDiscovery } from './uplink-pool-hooks';
import type { UplinkNodeList, UplinkRtcSignal } from './uplink-protocol';
import type { GatewaySessionClose } from './ws-stream-target';

export type MeshRuntimeConfig = {
  roles: VibeTermRoles;
  hubUrl: string | null;
  hubPublicUrl?: string | null;
  hubUrls?: string[];
  hubMode?: HubMode;
  hubPriority?: number;
  hubWriterEpoch?: number;
  hubPeers?: string[];
  hubAutoPromote?: boolean;
  hubAutoPromoteTimeoutMs?: number;
  uplinkPreferNearest?: boolean | null;
  peerPort: number;
  stunServers: string[];
  stunSource?: StunEnvSource;
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
  bindHost?: string;
  peerBindHost?: PeerBindHost;
};
export type CreateMeshRuntimeOptions = {
  db: AuthDb;
  gateway: GatewayRuntime;
  config: MeshRuntimeConfig;
  inboundHttpExtensions?: Array<(req: Request, ctx: DispatchContext) => Promise<Response | null>>;
  hub?: HubRuntime;
  /** Same-process hub to attach an in-memory uplink to (remote node in hub+A+B tests). */
  uplinkHub?: HubRuntime | null;
  wsFactory?: UplinkWsFactory;
  peerHostname?: PeerBindHost;
  startPeerServer?: boolean;
  pingIntervalMs?: number;
  scheduler?: MeshScheduler;
  userId?: string;
  loadNative?: LoadNative;
  canLoadNative?: () => boolean;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  linkFactory?: PeerLinkFactory;
  rtcHandshakeTimeoutMs?: number;
  tlsInfo?: HubTlsInfoProvider;
  /** 进程级共享的 hub 集合存储；双角色时 hub 侧与节点侧必须用同一实例。 */
  meshHubStore?: MeshHubStore;
  /** TLS 指纹轮询间隔；默认 10 分钟。TLS 服务无变更回调时用轮询刷新 node.status.hub.caFingerprint。 */
  tlsPollIntervalMs?: number;
  /** 由 packages/app assemble 注入：把 VIBETERM_HUB_MODE / VIBETERM_HUB_WRITER_EPOCH 写进 app.env。 */
  patchHubRoleEnv?: (patch: Record<string, string>) => Promise<void>;
  /** 由 packages/app assemble 注入：延迟调用 RuntimeController.requestRestart。 */
  scheduleHubRoleRestart?: (delayMs: number) => void;
  hubFetch?: HubPeerFetch;
  /** 本机节点名随 hub node.list 变化时回调，用于同步 site_settings.site_name。 */
  onLocalNodeName?: (name: string) => void;
};
export const TLS_STATUS_POLL_MS = 10 * 60 * 1000;
export {
  CONNECTION_ID_BYTES,
  SessionRegistry,
  generateConnectionId,
  type RegisterGatewaySessionInput,
  type RegisterGatewaySessionResult,
  type RegisteredGatewaySession,
} from './mesh-session-registry';

export type MeshRuntime = {
  readonly nodeId: string;
  readonly identity: NodeIdentityKeys;
  readonly hub: HubRuntime | null;
  readonly uplink: UplinkPool;
  readonly peers: PeerManager;
  readonly rtc: RtcPeerManager;
  readonly sessions: SessionRegistry;
  readonly userStore: UserStore;
  readonly userKeyService: UserKeyService;
  lastNodeList: UplinkNodeList | null;
  registerGatewaySession(entry: RegisterGatewaySessionInput): RegisterGatewaySessionResult;
  unregisterGatewaySession(sidOrSession: string | GatewaySession): void;
  handleRequest(req: Request, server: MeshUpgradeServer): Promise<MeshHandleResult>;
  invalidateAuthModeCache(): void;
  localUiGuard(req: Request): Response | null;
  guardGatewayWebSocket(req: Request, server: MeshUpgradeServer): Response | null | undefined;
  rewriteSelf(req: Request): Request | null;
  closeSocketsForUser(uid: string): void;
  closeSocketsForSid(sid: string): void;
  touchSocket(ws: MeshServerWebSocket): boolean;
  websocket: {
    open: (ws: MeshServerWebSocket) => void;
    message: (ws: MeshServerWebSocket, message: string | Buffer) => void;
    drain: (ws: MeshServerWebSocket) => void;
    close: (ws: MeshServerWebSocket, code: number, reason: string) => void;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
  onNodeEvent(cb: (event: NodeEventPayload) => void): () => void;
  onNodeList(
    cb: (list: UplinkNodeList, meta: { hubNodeId: string | null; generation: number }) => void
  ): () => void;
  attachedHub(): AttachedHub | null;
  /** 上级种类或中继目标变化后重建 uplink 池（`set-relays` 应用后自动触发）。 */
  reconfigureUplink(): Promise<void>;
  refreshTlsAndAdvertise(): Promise<void>;
  readonly relayPresence: RelayPresenceIndex | null;
  readonly relayOpener: RelayStreamOpener | null;
};

export type NetworkInterfacesFn = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export { STATUS_IFACE_CACHE_TTL_MS, attachKeyLogHeadNotify, createTtlCache };

function stripZoneId(address: string): string {
  const cut = address.indexOf('%');
  return cut === -1 ? address : address.slice(0, cut);
}

function parseIpv4Octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isAdvertisableIpv4(address: string): boolean {
  const o = parseIpv4Octets(stripZoneId(address));
  if (!o) return false;
  const [a, b] = o;
  if (a === 127) return false;
  if (a === 0) return o.some((n) => n !== 0);
  if (a === 169) return b !== 254;
  return a < 224 || a > 239;
}

function isAdvertisableIpv6(address: string): boolean {
  const w = parseIpv6Words(address);
  if (!w) return false;
  const w0 = w[0];
  if ((w0 & 0xffc0) === 0xfe80) return false;
  if ((w0 & 0xfe00) === 0xfc00) return false;
  if ((w0 & 0xffc0) === 0xfec0) return false;
  if ((w0 & 0xff00) === 0xff00) return false;
  if (w.slice(0, 7).some((x) => x !== 0)) return true;
  return w[7] > 1;
}

const CONTAINER_IFACE_PREFIXES = [
  'docker',
  'veth',
  'virbr',
  'lxdbr',
  'lxcbr',
  'cni',
  'flannel',
  'podman',
] as const;

export function isContainerOrientedIface(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('br-')) return true;
  return CONTAINER_IFACE_PREFIXES.some((prefix) => n === prefix || n.startsWith(prefix));
}

export type AdvertisablePeerAddressOpts = {
  iface?: string;
  allowCgnat?: boolean;
};

export function isAdvertisablePeerAddress(
  addr: os.NetworkInterfaceInfo,
  opts?: AdvertisablePeerAddressOpts
): boolean {
  if (addr.internal) return false;
  if (opts?.iface && isContainerOrientedIface(opts.iface)) return false;
  const family = addr.family as string | number;
  if (family === 'IPv4' || family === 4) {
    if (isFakeIpv4(addr.address) || (!opts?.allowCgnat && isCgnatIpv4(addr.address))) return false;
    return isAdvertisableIpv4(addr.address);
  }
  if (family === 'IPv6' || family === 6) return isAdvertisableIpv6(addr.address);
  return false;
}

export function enumeratePeerEndpoints(
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const allowCgnat = hasLocalCgnatAddress(interfaces);
  for (const [iface, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!isAdvertisablePeerAddress(addr, { iface, allowCgnat })) continue;
      const family = addr.family as string | number;
      const v6 = family === 'IPv6' || family === 6;
      const host = v6 ? `[${stripZoneId(addr.address)}]` : stripZoneId(addr.address);
      const url = `ws://${host}:${port}/peer`;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function peerFromDcSession(selfNodeId: string, rtcSession: string): string | null {
  if (!rtcSession.startsWith('dc:')) return null;
  const rest = rtcSession.slice(3);
  const idx = rest.indexOf(':');
  if (idx <= 0) return null;
  const a = rest.slice(0, idx);
  const b = rest.slice(idx + 1);
  const self = selfNodeId.toLowerCase();
  if (a === self) return b;
  if (b === self) return a;
  return null;
}

function resolvePeerBindHost(
  explicit?: string | string[],
  fromConfig?: string | string[]
): string[] {
  const raw = explicit ?? fromConfig ?? gatewayConfig.peerBindHost;
  const parts = (Array.isArray(raw) ? raw : raw.split(',')).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [...gatewayConfig.peerBindHost];
}

function turnConfig(config: MeshRuntimeConfig): CachedRtcConfig['turn'] {
  return turnFromMesh(config);
}

function createKeyLogApplier(keys: UserKeyService, onHeadChanged?: () => void): KeyLogApplier {
  return {
    head: (userId, signal) => keys.head(userId, signal),
    list: (userId, fromSeq, signal, limit) => keys.list(userId, fromSeq, signal, limit),
    async applyMany(userId, records, signal) {
      const result = await keys.applyMany(userId, records, signal);
      if (result.applied > 0) onHeadChanged?.();
      return result.ok
        ? { applied: result.applied }
        : { applied: result.applied, error: result.error };
    },
  };
}

export type KeyLogUplinkPort = {
  sendCtl(msg: { t: 'key.log.append'; bytes: Uint8Array; sig: Uint8Array; force?: boolean }): void;
  appendAndAck(record: {
    bytes: Uint8Array;
    sig: Uint8Array;
    force?: boolean;
  }): Promise<{ ok: boolean; seq?: bigint | number; error?: string }>;
  queryHubHead(): Promise<{ seq: bigint | number; hash: Uint8Array } | null>;
  queryKeyLogAt(seq: bigint): Promise<{ bytes: Uint8Array; sig: Uint8Array } | null>;
};

export function createKeyLogPublisher(
  uplink: KeyLogUplinkPort,
  notifyHead: () => void
): KeyLogPublisher {
  return {
    publish(record) {
      try {
        const force = (record as { force?: boolean }).force === true;
        uplink.sendCtl({
          t: 'key.log.append',
          bytes: record.bytes,
          sig: record.sig,
          ...(force ? { force: true } : {}),
        });
      } catch {}
      notifyHead();
    },
    async publishAndAck(record) {
      // hub ACK 时本地 head 尚未更新；status 刷新挂在 apply 成功路径，避免读到旧 head
      const force = (record as { force?: boolean }).force === true;
      const ack = await uplink.appendAndAck({ ...record, force });
      if (ack.ok) return { ok: true, seq: ack.seq ?? 0n };
      return { ok: false, error: ack.error ?? 'hub_error' };
    },
    queryHubHead: () => uplink.queryHubHead(),
    queryKeyLogAt: (seq) => uplink.queryKeyLogAt(seq),
  };
}

export function resolveUserId(
  userStore: UserStore,
  nodeIdHex: string,
  explicit?: string
): string | null {
  return resolveMeshUserId(userStore, { nodeId: nodeIdHex, explicit });
}

function hubEndpointUrl(config: MeshRuntimeConfig): string {
  return (
    (config.roles.hub ? (config.hubPublicUrl ?? config.hubUrl) : config.hubUrl) ??
    'http://127.0.0.1'
  );
}

function hubSeedUrls(config: MeshRuntimeConfig): string[] {
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    const trimmed = raw?.trim();
    if (!trimmed) return;
    if (out.some((existing) => existing === trimmed)) return;
    out.push(trimmed);
  };
  add(config.hubUrl);
  for (const url of config.hubUrls ?? []) add(url);
  if (out.length === 0) add(hubEndpointUrl(config));
  return out;
}

function meshAuthorizedHub(d: MeshDeps, hubNodeId: string): boolean {
  const uid = resolveMeshUserId(d.userStore, {
    nodeId: d.identity.nodeIdHex,
    explicit: d.userIdOf(),
  });
  return isAuthorizedHub({
    hubNodeId,
    selfId: d.identity.nodeIdHex,
    envPeers: envPeerSet(d.config.hubPeers ?? gatewayConfig.hubPeers),
    signed: lookupSignedHubAuthorization(d.userStore, uid, hubNodeId),
  });
}

function retiredHubSeedUrls(d: MeshDeps): string[] {
  const uid = resolveMeshUserId(d.userStore, {
    nodeId: d.identity.nodeIdHex,
    explicit: d.userIdOf(),
  });
  const urls: string[] = [];
  if (uid) {
    for (const row of d.userStore.listHubAuthorizationsByUser(uid)) {
      if (row.status === 'retired' && row.publicUrl) urls.push(row.publicUrl);
    }
  }
  for (const row of d.hubStore.list()) {
    if (!meshAuthorizedHub(d, row.hubNodeId)) urls.push(row.publicUrl);
  }
  return urls;
}

export function hubRoleAdvertisement(
  config: MeshRuntimeConfig,
  caFingerprint: string | null,
  liveHub?: { mode(): HubMode; writerEpoch(): number } | null
): HubAdvertisement | undefined {
  if (!config.roles.hub) return undefined;
  const publicUrl = config.hubPublicUrl ?? config.hubUrl;
  if (!publicUrl) return undefined;
  return {
    publicUrl,
    mode: liveHub?.mode() ?? config.hubMode ?? gatewayConfig.hubMode,
    priority: config.hubPriority ?? gatewayConfig.hubPriority,
    writerEpoch: liveHub?.writerEpoch() ?? config.hubWriterEpoch ?? gatewayConfig.hubWriterEpoch,
    caFingerprint,
  };
}

function rtcSignalCtl(msg: RtcSignalMessage) {
  return {
    t: 'rtc.signal' as const,
    rtcSession: msg.rtcSession,
    from: msg.from,
    to: msg.to,
    ...(msg.sdp ? { sdp: msg.sdp } : {}),
    ...(msg.candidate ? { candidate: msg.candidate } : {}),
  };
}

function sendControl(
  gateway: GatewayRuntime,
  session: GatewaySession,
  kind: number,
  payload: Uint8Array
): ControlSendStatus {
  try {
    const ws = gateway.wsServer as {
      sendControl?: (s: GatewaySession, k: number, p: Uint8Array) => ControlSendStatus;
      sendEnvelope?: (s: GatewaySession, k: number, p: Uint8Array) => void;
    };
    if (typeof ws.sendControl === 'function') return ws.sendControl(session, kind, payload);
    ws.sendEnvelope?.(session, kind, payload);
    return 'sent';
  } catch {
    return 'closed';
  }
}

async function stopQuietly(parts: Array<[string, () => void | Promise<void>]>): Promise<void> {
  for (const [label, fn] of parts) {
    try {
      await fn();
    } catch (err) {
      console.error(`[vibeterm] ${label} stop failed`, err);
    }
  }
}

async function createMeshStoresAndServices(opts: CreateMeshRuntimeOptions) {
  const { db, gateway, config } = opts;
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const challengeStore = new ChallengeStore();
  const identity = await ensureNodeIdentity(new NodeIdentityStore(db), {
    hubUrl: config.hubUrl ?? undefined,
  });
  const keyLogService = new UserKeyService({
    db,
    userStore,
    keyLogStore,
    nodeSessionStore,
    // 计数器推进与记录落库同一个事务：同一条记录会被验多次（预演 + 落账），只能推进一次。
    deferredPasskeyVerifier: () => makeDeferredVerifyPasskeyAssertion(userStore),
  });
  const peerHolder = { manager: null } as { manager: PeerManager | null };
  const httpHolder = { runtime: null } as { runtime: MeshHttpRuntime | null };
  const notifyKeyLogHead = () => {
    peerHolder.manager?.notifyKeyLogHeadChanged();
    httpHolder.runtime?.auth.invalidateAuthModeCache();
  };
  keyLogService.apply = attachKeyLogHeadNotify(
    keyLogService.apply.bind(keyLogService),
    notifyKeyLogHead
  );
  const applier = createKeyLogApplier(keyLogService, notifyKeyLogHead);
  const userIdOf = () => resolveUserId(userStore, identity.nodeIdHex, opts.userId) ?? '';
  const nodeEvents = new Set<(event: NodeEventPayload) => void>();
  const nodeEventDedupe = new NodeEventDedupe();
  const state = {
    lastRtc: { stun: [] as string[], turn: turnConfig(config) } as CachedRtcConfig | null,
    lastStunLogKey: null as string | null,
    lastNodeList: null as UplinkNodeList | null,
    hubPresenceLive: false,
    hubPresenceStaleUntil: 0,
    hubPresenceDecay: null as { clear: () => void } | null,
    hubGeneration: 0,
    caFingerprint: null as string | null,
  };
  const hubStore = opts.meshHubStore ?? new MeshHubStore(db);
  const emitNodeEvent = (event: NodeEventPayload) => {
    if (event.status === 'offline' || event.status === 'revoked') notifyNodeOffline(event.nodeId);
    // 吊销即失信：这台节点手上的窗格授权全部作废，重新准入后必须重签
    if (event.status === 'revoked') dropPaneGrantsOfNode(event.nodeId);
    for (const cb of nodeEvents)
      try {
        cb(event);
      } catch {}
  };
  const emitListNodeEvent = (event: NodeEventProjection) => {
    if (!nodeEventDedupe.shouldEmitList(event)) return;
    emitNodeEvent(event);
  };
  const emitSyntheticOffline = (nodeId: string) => {
    if (!nodeEventDedupe.shouldEmitSyntheticOffline(nodeId, state.hubGeneration)) return;
    emitNodeEvent({ nodeId, status: 'offline' });
  };
  const emitRevoked = (nodeId: string) => {
    nodeEventDedupe.onRevoke(nodeId);
    emitNodeEvent({ nodeId, status: 'revoked' });
  };
  const signalListeners = new Set<(signal: RtcSignalMessage) => void>();
  const hub = config.roles.hub
    ? (opts.hub ??
      new HubRuntime({
        db,
        userStore,
        keyLogSource: createHubKeyLogSource(keyLogService, keyLogStore),
        config: {
          publicUrl: hubEndpointUrl(config),
          stun: config.stunServers,
          stunSource: config.stunSource,
          turn: (turnConfig(config) as HubTurnConfig) ?? null,
          nodeId: identity.nodeIdHex,
          hubNodeId: identity.nodeIdHex,
          siteName: resolveSiteName(),
          mode: config.hubMode ?? gatewayConfig.hubMode,
          priority: config.hubPriority ?? gatewayConfig.hubPriority,
          writerEpoch: config.hubWriterEpoch ?? gatewayConfig.hubWriterEpoch,
          authorizedHubIds: config.hubPeers ?? gatewayConfig.hubPeers,
        },
        meshHubs: hubStore,
        authenticate: (req) => {
          const result = authenticateRequest(req, { roles: config.roles, nodeSessionStore });
          if (!result.ok || !result.userId) return null;
          const via = getMeshRequestContext(req).via ?? MESH_VIA_SELF;
          return {
            userId: result.userId,
            entryNodeId: via === MESH_VIA_SELF ? identity.nodeIdHex : via,
            sid: result.sid,
          };
        },
        tlsInfo: opts.tlsInfo,
        hubTrust: new HubTrustStore(db),
        hubFetch: opts.hubFetch,
        patchHostEnv: opts.patchHubRoleEnv,
        scheduleRestart: opts.scheduleHubRoleRestart,
        hubRoleInstalled: config.roles.hub,
        autoPromote: config.hubAutoPromote ?? gatewayConfig.hubAutoPromote,
        autoPromoteTimeoutMs:
          config.hubAutoPromoteTimeoutMs ?? gatewayConfig.hubAutoPromoteTimeoutMs,
        syncLocalSiteName: opts.onLocalNodeName,
      }))
    : (opts.hub ?? null);
  const relay = createRelayWiring({ db, identity, userIdOf });
  return {
    opts,
    db,
    gateway,
    config,
    userStore,
    nodeSessionStore,
    challengeStore,
    identity,
    keyLogService,
    applier,
    userIdOf,
    nodeEvents,
    nodeEventDedupe,
    state,
    emitListNodeEvent,
    emitSyntheticOffline,
    emitRevoked,
    signalListeners,
    hub,
    hubStore,
    relay,
    peerHolder,
    innerSignalsHolder: { router: null } as { router: MeshRtcSignalRouter | null },
    startBrowserAcceptHolder: { fn() {} } as { fn: (rtcSession: string) => void },
    httpHolder,
    interfacesFn: opts.networkInterfaces ?? os.networkInterfaces,
    loadNative: (opts.loadNative ?? (async () => null)) as LoadNative,
  };
}

function createSessionBindings(s: Awaited<ReturnType<typeof createMeshStoresAndServices>>) {
  const { opts, gateway, config, identity, loadNative, state } = s;
  const sessions = new SessionRegistry();
  const bulk = new BulkTransferService({ files: filesBulkHooks });
  const acceptingBrowser = new Set<string>();
  const rtc = new RtcPeerManager({
    loadNative,
    canLoadNative: opts.canLoadNative ?? (() => opts.loadNative !== undefined),
    iceConfigProvider: () => resolveMeshRtcConfig(config, state.lastRtc),
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore: s.userStore,
    handshakeTimeoutMs: opts.rtcHandshakeTimeoutMs,
    sendControl: (session, kind, payload) => sendControl(gateway, session, kind, payload),
    deliverInbound: (session, bytes) => {
      const entry = sessions.getBySession(session);
      if (!entry || !verifyBoundSession(entry)) return;
      gateway.wsServer.deliverRtcInbound(session, bytes);
    },
    verifyInbound: (session) => {
      const entry = sessions.getBySession(session);
      return entry ? verifyBoundSession(entry) : false;
    },
  });
  if (typeof gateway.wsServer.setOnCarrierSwitchAck === 'function') {
    gateway.wsServer.setOnCarrierSwitchAck((session, epoch, rtcSession) => {
      rtc.handleCarrierSwitchAck(session, epoch, rtcSession);
    });
  }
  const wsServer = gateway.wsServer as {
    setOnSessionClosed?: (handler: ((session: GatewaySession) => void) | null) => void;
    closeSession?: (session: GatewaySession, code: number, reason: string) => void;
  };
  if (typeof wsServer.setOnSessionClosed === 'function') {
    wsServer.setOnSessionClosed((session) => {
      const entry = sessions.getBySession(session);
      if (entry) teardownBinding(entry);
      else rtc.notifySessionClosed(session);
    });
  }
  const tearingDown = new WeakSet<GatewaySession>();
  /**
   * 直连入站帧的会话校验：逐帧压库太贵，按复验窗口节流（`session.closed` 的判定不节流）；
   * 撤销的即时性由 key log 效果回调兜底。`force` 供那条回调复核用，绕过节流真查一次库。
   */
  function verifyBoundSession(entry: RegisteredGatewaySession, force = false): boolean {
    if (entry.session.closed) {
      teardownBinding(entry);
      return false;
    }
    const now = Date.now();
    if (!force && !sessionVerifyDue(entry, now)) return true;
    const verified = s.nodeSessionStore.verify(entry.sid, { viaNodeId: entry.via, now });
    if (!verified.ok) {
      teardownBinding(entry);
      return false;
    }
    entry.lastVerifyAt = now;
    entry.nextVerifyAt = sessionVerifyDeadline(verified.session, now);
    return true;
  }
  /**
   * `close` 缺省即「会话真的失效了」关成 4401；链路侧拆流由调用方给非终止码，
   * 否则入口会把链路抖动当成需要重新登录透给浏览器。注册表清理对两条路径一致。
   */
  function teardownBinding(entry: RegisteredGatewaySession, close?: GatewaySessionClose): void {
    if (tearingDown.has(entry.session)) return;
    tearingDown.add(entry.session);
    sessions.unregisterSession(entry.session);
    rtc.notifySessionClosed(entry.session);
    try {
      entry.pc?.close();
    } catch {}
    bulk.abortByOwner(entry.connectionId);
    const code = close?.code ?? WS_CLOSE_LOGIN_REQUIRED;
    const reason = close?.reason ?? 'NODE_LOGIN_REQUIRED';
    if (!entry.session.closed && typeof wsServer.closeSession === 'function') {
      try {
        wsServer.closeSession(entry.session, code, reason);
      } catch {}
    }
  }
  return { sessions, bulk, acceptingBrowser, rtc, verifyBoundSession, teardownBinding };
}

async function constructMeshDeps(opts: CreateMeshRuntimeOptions) {
  const stores = await createMeshStoresAndServices(opts);
  stores.keyLogService.onApplied = bindKeyLogProjection({
    hubStore: stores.hubStore,
    hub: stores.hub,
    relay: stores.relay,
    selfId: stores.identity.nodeIdHex,
    userStore: stores.userStore,
    state: stores.state,
    peerHolder: stores.peerHolder,
    emitListNodeEvent: stores.emitListNodeEvent,
    onLocalNodeName: opts.onLocalNodeName,
    userIdOf: stores.userIdOf,
    onNodeRevoked: (nodeId) => {
      stores.peerHolder.manager?.onRevoked(nodeId);
      stores.emitRevoked(nodeId);
    },
    // 所有应用路径（本地追加、uplink / 中继同步、peer 追赶）都汇到 onApplied：撤销效果
    // 只有从这里升上去，别处做的改密 / 删通行密钥同步过来才会即时断开已挂载的连接。
    onKeyLogEffects: (uid, effects) => {
      stores.httpHolder.runtime?.applyKeyLogEffects(uid, effects);
    },
  });
  const bindings = createSessionBindings(stores);
  const scheduler = opts.scheduler ?? defaultScheduler();
  const refreshTls = async () => {
    const tls = await Promise.resolve(
      opts.tlsInfo?.() ?? { caFingerprint: null as string | null, caPem: null }
    );
    stores.state.caFingerprint = tls.caFingerprint ?? null;
  };
  await refreshTls();
  const ifaceCache = createTtlCache(stores.interfacesFn, STATUS_IFACE_CACHE_TTL_MS);
  const statusProvider = () => {
    const version = getDisplayVersion();
    const ids = stores.userStore.listPeers().map((row) => row.nodeId);
    const peerReach = peerReachPayload(stores.identity.nodeIdHex, ids);
    return {
      version,
      tmux: true,
      direct_capable: bindings.rtc.available,
      inventory: { version },
      endpoints: enumeratePeerEndpoints(
        stores.peerHolder.manager?.listenPort ?? stores.config.peerPort,
        ifaceCache.get()
      ),
      hub: hubRoleAdvertisement(stores.config, stores.state.caFingerprint, stores.hub),
      ...(Object.keys(peerReach).length > 0 ? { peer_reach: peerReach } : {}),
    };
  };
  const refreshLocalInterfaces = () => ifaceCache.refresh();
  return {
    ...stores,
    ...bindings,
    scheduler,
    statusProvider,
    refreshTls,
    refreshLocalInterfaces,
    invalidateStatusCache: ifaceCache.invalidate,
  };
}

type MeshDeps = Awaited<ReturnType<typeof constructMeshDeps>>;
type RejectPeerFn = (nodeId: string, alwaysDelete: boolean) => boolean;
type EnsureDcFn = (peerNodeId: string, rtcSession: string) => void;

function handleUplinkNodeList(d: MeshDeps, list: UplinkNodeList, rejectPeer: RejectPeerFn): void {
  applyUplinkNodeList(
    {
      ...d,
      ...primaryNodeListApplyPatch(
        relayMultiAttachOf(d.relay),
        d.state.lastNodeList?.nodes ?? [],
        list
      ),
    },
    list,
    rejectPeer
  );
  noteMeshStunConfig(d.state, d.config);
  syncMeshRtcProbes(d.rtc);
}

function createUplinkWiring(d: MeshDeps) {
  const { opts, config, identity, userStore, hub } = d;
  const hubTrust = new HubTrustStore(d.db);
  for (const seed of hubSeedUrls(config)) {
    if (hubTrust.get(seed)?.caPem) continue;
    let label = seed;
    try {
      label = canonicalHubUrl(seed);
    } catch {}
    console.warn(`[uplink] no pinned CA for hub=${label}; using system trust`);
  }
  const rejectPeer = (nodeId: string, alwaysDelete: boolean) => {
    const cert = userStore.getCert(nodeId);
    const uid = d.userIdOf();
    if (cert && uid && cert.userId === uid && cert.revokedLogSeq == null) return false;
    if (cert?.revokedLogSeq != null) {
      d.peerHolder.manager?.onRevoked(nodeId);
      d.emitRevoked(nodeId);
      if (alwaysDelete) userStore.deletePeer(nodeId);
    } else {
      userStore.deletePeer(nodeId);
    }
    return true;
  };
  const ensureDc = (peerNodeId: string, rtcSession: string) => {
    if (rtcSession.startsWith('dc:')) {
      hub?.uplink.ensureDcSession(d.userIdOf(), identity.nodeIdHex, peerNodeId);
    }
  };
  const uplinkHub = opts.uplinkHub !== undefined ? opts.uplinkHub : hub;
  const ownHubUrl = config.hubPublicUrl ?? hubEndpointUrl(config);
  const relayOverrides = relayUplinkOverrides(d.relay, {
    nameProvider: () => selfDisplayNameOf(d) ?? '',
  });
  const uplink = new UplinkPool({
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userId: d.userIdOf,
    keyLogApplier: d.applier,
    userStore,
    statusProvider: d.statusProvider,
    candidates: () => {
      if (relayOverrides.relayMode()) return relayOverrides.candidates();
      const endpoints = d.hubStore.orderedEndpoints({
        include: (id) => meshHubNotRetired(d, id),
      });
      const blocked = retiredHubSeedUrls(d);
      const seeds = hubSeedUrls(config).filter(
        (url) => !blocked.some((retired) => sameHubUrl(retired, url))
      );
      return mergeUplinkCandidates(endpoints, seeds);
    },
    hubTrust,
    wsFactory: opts.wsFactory,
    scheduler: d.scheduler,
    pingIntervalMs: opts.pingIntervalMs,
    preferNearest: config.uplinkPreferNearest ?? gatewayConfig.uplinkPreferNearest,
    localRoles: config.roles,
    createClient: relayOverrides.createClient,
    probeHealthz: relayOverrides.probeHealthz,
    isLocalCandidate: (cand) =>
      !relayOverrides.relayMode() &&
      Boolean(uplinkHub) &&
      isSelfHubCandidate(cand, { nodeId: identity.nodeIdHex, publicUrl: ownHubUrl }),
    connectLocal: async (client, signal) => {
      if (!uplinkHub) throw new Error('no local hub');
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const online = client.connectWithLink(nodeLink, signal);
      uplinkHub.attachLocalNode(hubLink);
      await online;
    },
    onHubTokens: (msg, source) => {
      d.hub?.receiveHubTokens(msg, source);
    },
    onHubAttachments: (msg, source) => {
      d.hub?.receiveHubAttachments(msg, source);
    },
    onHubForward: (msg, source) => {
      d.hub?.receiveHubForward(msg, source);
    },
    onHubWriteForward: (msg, source) => {
      d.hub?.receiveHubWriteForward(msg, source);
    },
    onHubRelayStream: (stream, source) => {
      d.hub?.receiveHubRelay(stream, source);
    },
    onEnrollRedeemed: (msg) => {
      d.httpHolder.runtime?.mesh.forwardEnrollRedeemed({
        enrollPk: msg.enroll_pk,
        certificate: msg.certificate,
        certSig: msg.cert_sig,
        nodeId: msg.nodeId,
        entrySid: msg.entrySid,
      });
    },
    onNodeList: (list) => handleUplinkNodeList(d, list, rejectPeer),
    onRtcSignal: (msg: UplinkRtcSignal) =>
      dispatchUplinkRtcSignal(d, identity.nodeIdHex, msg, peerFromDcSession),
  });
  bindHubUplinkHooks(hub, uplink);
  bindRelayReconcile(d.relay, uplink, d.hubStore);
  bindRelayUplinkFactory(d.relay, relayOverrides.createClient);
  return { uplink, ensureDc };
}

function startTlsFingerprintPoll(
  opts: CreateMeshRuntimeOptions,
  scheduler: MeshScheduler,
  refresh: () => void
): { clear: () => void } | null {
  if (!opts.tlsInfo) return null;
  const intervalMs = opts.tlsPollIntervalMs ?? TLS_STATUS_POLL_MS;
  return scheduler.interval(() => {
    void refresh();
  }, intervalMs);
}

function createPeerWiring(d: MeshDeps, uplink: UplinkPool, ensureDc: EnsureDcFn) {
  const { opts, config, identity, userStore, state, rtc, sessions, hub } = d;
  const noopUpgrade: MeshUpgradeServer = { upgrade: () => false };
  const dispatchInboundHttp = async (request: Request, ctx: DispatchContext): Promise<Response> => {
    const dispatchContext = applyInboundDispatchContext(request, ctx);
    const meshHttp = d.httpHolder.runtime;
    if (meshHttp) {
      const meshRes = await meshHttp.handleRequest(request, noopUpgrade);
      if (meshRes instanceof Response) return meshRes;
    }
    if (config.roles.hub && hub) {
      const hubRes = await hub.handleRequest(request, noopUpgrade);
      if (hubRes instanceof Response) return hubRes;
    }
    for (const extension of opts.inboundHttpExtensions ?? []) {
      const response = await extension(request, dispatchContext);
      if (response) return response;
    }
    return d.gateway.dispatchHttp(request, dispatchContext);
  };
  const peerManager = new PeerManager({
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore,
    uplink,
    peerPort: config.peerPort,
    keyLogApplier: d.applier,
    statusProvider: d.statusProvider,
    sessionStore: d.nodeSessionStore,
    dispatchHttp: dispatchInboundHttp,
    wsServer: d.gateway.wsServer,
    hostname: resolvePeerBindHost(opts.peerHostname, config.peerBindHost),
    startServer: opts.startPeerServer,
    scheduler: d.scheduler,
    rtc,
    linkFactory: opts.linkFactory,
    interfacesFn: d.interfacesFn,
    refreshLocalInterfaces: d.refreshLocalInterfaces,
    hubHost: () => attachedHubHost(uplink.attachedHub(), hubEndpointUrl(config)),
    onGatewaySession: (session, auth) => sessions.register({ ...auth, session }).ok,
    onGatewaySessionClose: (session, close) => {
      const entry = sessions.getBySession(session);
      if (entry) d.teardownBinding(entry, close);
      else sessions.unregisterSession(session);
    },
    onBrowserSignal: (signal, fromNodeId) => {
      d.innerSignalsHolder.router?.deliverLocal(signal, fromNodeId);
      d.startBrowserAcceptHolder.fn(signal.rtcSession);
    },
    ensureDcSession: ensureDc,
    onLinkInfo: (info) => {
      notePeerTransport(info.nodeId, info.transport);
      const listed = state.lastNodeList?.nodes.find((node) => node.id === info.nodeId);
      const peer = userStore.listPeers().find((row) => row.nodeId === info.nodeId);
      const hubOnline = listed?.online === true;
      const mgr = d.peerHolder.manager;
      d.emitListNodeEvent({
        nodeId: info.nodeId,
        status: isPeerReachable(info.reach) || hubOnline ? 'online' : 'offline',
        reach: info.reach,
        transport: info.transport,
        rttMs: info.rttMs,
        inventory: peer?.inventoryJson ?? null,
        version: listed?.version ?? undefined,
        direct_capable: peer?.directCapable,
        name: listed?.name,
        viaRelay: mgr?.viaRelayOf(info.nodeId) ?? null,
        relayPresence: mgr?.relayPresenceOf(info.nodeId),
        dcBreaker: info.dcBreaker ?? null,
      });
    },
  });
  d.peerHolder.manager = peerManager;
  const attach = installNodeRelayAttach(d, uplink, peerManager);
  const unsubscribeUplinkState = uplink.onStateChange((liveState) => {
    const url = uplink.attachedHub()?.publicUrl ?? attach?.presence.primaryUrl() ?? null;
    const live = uplink.liveClient();
    const rtt = live instanceof RelayUplinkClient ? live.rttMs : null;
    attach?.handlePrimaryState(liveState, url, rtt);
    if (liveState === 'online') {
      peerManager.onHubSwitched();
      return;
    }
    if (attach && d.relay.secrets.uplinkKind() === 'relay') return;
    if (!state.hubPresenceLive) return;
    scheduleHubPresenceDecay(d, state, () => peerManager.listReach());
  });
  return { peerManager, unsubscribeUplinkState };
}

function installNodeRelayAttach(d: MeshDeps, uplink: UplinkPool, peerManager: PeerManager) {
  return installRelayMultiAttach({
    wiring: d.relay,
    uplink,
    peerBind: peerManager,
    userId: d.userIdOf,
    keyLogApplier: d.applier,
    userStore: d.userStore,
    statusProvider: d.statusProvider,
    scheduler: d.scheduler,
    wsFactory: d.opts.wsFactory,
    pingIntervalMs: d.opts.pingIntervalMs,
    onRtcSignal: (msg) => dispatchUplinkRtcSignal(d, d.identity.nodeIdHex, msg, peerFromDcSession),
    onExclusiveOffline: (ids) => {
      for (const id of ids) d.emitSyntheticOffline(id);
    },
    rtc: d.state,
    noteStun: () => {
      noteMeshStunConfig(d.state, d.config);
      syncMeshRtcProbes(d.rtc);
    },
  });
}

export { HUB_PRESENCE_STALE_MS, setHubPresenceStaleMs };

function createRtcBrowserWiring(
  d: MeshDeps,
  uplink: UplinkPool,
  peerManager: PeerManager,
  ensureDc: EnsureDcFn
) {
  const { identity, rtc, sessions, bulk } = d;
  const innerSignals = new MeshRtcSignalRouter({
    selfNodeId: identity.nodeIdHex,
    shouldCacheLocal(signal, sourceNodeId) {
      const auth = rtc.authorizationOf(signal.rtcSession);
      if (!auth) return false;
      if (signal.to.toLowerCase() !== identity.nodeIdHex.toLowerCase()) return false;
      if (
        sourceNodeId &&
        auth.via !== MESH_VIA_SELF &&
        sourceNodeId.toLowerCase() !== auth.via.toLowerCase()
      ) {
        return false;
      }
      return true;
    },
    sendCtl(nodeId, msg) {
      ensureDc(nodeId, msg.rtcSession);
      const live = peerManager.getLive(nodeId);
      if (live) {
        live.ctl.send(encodeJsonBytes(rtcSignalCtl(msg)));
        return;
      }
      try {
        sendRtcOverUplink(d.relay, uplink, nodeId, rtcSignalCtl(msg));
      } catch {}
    },
  });
  d.innerSignalsHolder.router = innerSignals;
  const startBrowserAccept = (rtcSession: string) => {
    if (!rtcSession || d.acceptingBrowser.has(rtcSession)) return;
    const auth = rtc.authorizationOf(rtcSession);
    if (!auth) return;
    d.acceptingBrowser.add(rtcSession);
    if (!innerSignals.ownerOf(rtcSession)) {
      innerSignals.register(rtcSession, {
        browserSessionId: auth.sid,
        targetNodeId: identity.nodeIdHex,
      });
    }
    const signaling = {
      send: (msg: RtcSignalMessage) => innerSignals.send(msg),
      onMessage: (cb: (msg: RtcSignalMessage) => void) => innerSignals.onLocal(rtcSession, cb),
    };
    void rtc
      .acceptBrowser(rtcSession, signaling)
      .then((result) => {
        const binding = result.connectionId
          ? sessions.getByConnectionId(result.connectionId)
          : sessions.get(result.sid);
        if (
          binding &&
          !binding.session.closed &&
          binding.uid === result.uid &&
          binding.via === result.via &&
          binding.sid === result.sid &&
          d.verifyBoundSession(binding)
        ) {
          binding.pc = result.pc;
          rtc.attachDirect(binding.session, result.carrier, { rtcSession: result.rtcSession });
          result.pc.onDataChannel((dc) => {
            if (parseBulkChannelLabel(dc.getLabel?.())) {
              bulk.attachChannel(dc, {
                uid: result.uid,
                ownerKey: binding.connectionId,
                verify: () => d.verifyBoundSession(binding),
              });
            }
          });
        } else {
          try {
            result.carrier.close(1000, 'session-mismatch');
          } catch {}
          try {
            result.pc.close();
          } catch {}
        }
      })
      .catch(() => {})
      .finally(() => {
        d.acceptingBrowser.delete(rtcSession);
        innerSignals.unregister(rtcSession);
      });
  };
  d.startBrowserAcceptHolder.fn = startBrowserAccept;
  const fingerprint: RtcFingerprintProvider = rtc;
  const signals = {
    send(signal: RtcSignalMessage, owner?: { uid: string; sid: string }) {
      if (owner && signal.from === 'browser' && !innerSignals.ownerOf(signal.rtcSession)) {
        innerSignals.register(signal.rtcSession, {
          browserSessionId: owner.sid,
          targetNodeId: signal.to,
        });
      }
      if (
        signal.from === 'browser' &&
        signal.to.toLowerCase() === identity.nodeIdHex.toLowerCase()
      ) {
        startBrowserAccept(signal.rtcSession);
      }
      innerSignals.send(signal, owner);
    },
    subscribe(cb: (signal: RtcSignalMessage) => void) {
      const offRouter = innerSignals.subscribe(cb);
      d.signalListeners.add(cb);
      return () => {
        offRouter();
        d.signalListeners.delete(cb);
      };
    },
  };
  return { fingerprint, signals };
}
function wireMeshEventsAndSessions(d: MeshDeps) {
  const { uplink, ensureDc } = createUplinkWiring(d);
  const { peerManager, unsubscribeUplinkState } = createPeerWiring(d, uplink, ensureDc);
  return {
    uplink,
    peerManager,
    unsubscribeUplinkState,
    ...createRtcBrowserWiring(d, uplink, peerManager, ensureDc),
  };
}

/** standalone 机器也要能走中继接入；本机登录门未建好时读不到就当未生效。 */
function relayLocalAuthEffective(http: MeshHttpRuntime): () => boolean {
  return () => {
    try {
      return http.auth.isLocalAuthEffective();
    } catch {
      return false;
    }
  };
}

function wireRelayRoutes(
  http: MeshHttpRuntime,
  input: {
    d: MeshDeps;
    config: MeshDeps['config'];
    nodeId: string;
    userStore: UserStore;
    uplink: UplinkPool;
  }
): void {
  http.setRelayRoutes(
    createRelayRoutes({
      wiring: input.d.relay,
      roles: input.config.roles,
      nodeSessionStore: input.d.nodeSessionStore,
      trustProxy: gatewayConfig.trustProxy,
      localAuthEffective: relayLocalAuthEffective(http),
      nodeId: input.nodeId,
      userStore: input.userStore,
      keyLogService: input.d.keyLogService,
      uplink: input.uplink,
    })
  );
}

function wireMeshHttp(
  d: MeshDeps,
  w: ReturnType<typeof wireMeshEventsAndSessions>
): MeshHttpRuntime {
  const { config, identity, userStore, state } = d;
  const { uplink, peerManager, fingerprint, signals } = w;
  const peers = {
    getLink: (nodeId: string, opts?: PeerLinkGetOpts) => peerManager.getLink(nodeId, opts),
    listReach: () => peerManager.listReach(),
    transportOf: (nodeId: string) => peerManager.transportOf(nodeId),
    rttOf: (nodeId: string) => peerManager.rttOf(nodeId),
    linkSinceAtOf: (nodeId: string) => peerManager.linkDetailOf(nodeId).linkSinceAt,
    linkDetailOf: (nodeId: string) => peerManager.linkDetailOf(nodeId),
    listHubOnline: () =>
      listHubOnlineIds(
        state,
        uplink.state === 'online',
        d.scheduler.now(),
        relayMultiAttachOf(d.relay)?.listHubOnline(d.scheduler.now()) ?? null
      ),
    onNodeEvent: (cb: (event: NodeEventPayload) => void) => {
      d.nodeEvents.add(cb);
      return () => {
        d.nodeEvents.delete(cb);
      };
    },
  };
  const streams: StreamOpener = {
    openHttpStream: (link, open, body, signal) =>
      openHttpStream(link, { type: 'http', ...open }, body, signal),
    openWsStream: (link, auth, cid, share) => openAdaptedWsStream(link, auth, cid, share),
  };
  const publisher = createKeyLogPublisher(uplink, () =>
    d.peerHolder.manager?.notifyKeyLogHeadChanged()
  );
  const http = new MeshHttpRuntime({
    roles: config.roles,
    nodeId: identity.nodeIdHex,
    nodePk: identity.edPublicKey,
    userStore,
    keyLogService: d.keyLogService,
    challengeStore: d.challengeStore,
    nodeSessionStore: d.nodeSessionStore,
    peers,
    streams,
    publisher,
    rtc: {
      fingerprint,
      signals,
      config: { getRtcConfig: () => meshRtcConfigResponse(config, state.lastRtc) },
    },
    selfStatus: d.statusProvider,
    listedNames: () => {
      const rows: Array<{ id: string; name: string }> = [];
      // `null` = 本进程还没应用过任何成员列表；空数组是「应用过、但一台对端都没有」
      // （中继列表不含本机，单节点租户就是这一档），两者对同步进度的含义完全相反。
      if (!state.lastNodeList) return null;
      for (const node of state.lastNodeList.nodes) rows.push({ id: node.id, name: node.name });
      if (state.lastNodeList.hubs) {
        for (const hub of state.lastNodeList.hubs) {
          if (hub.name) rows.push({ id: hub.nodeId, name: hub.name });
        }
      } else if (state.lastNodeList.hub?.name) {
        rows.push({ id: state.lastNodeList.hub.nodeId, name: state.lastNodeList.hub.name });
      }
      return rows;
    },
    selfName: () => selfDisplayNameOf(d),
    primaryUserId: d.userIdOf() || undefined,
    hubPublicUrl: hubEndpointUrl(config),
    hubStore: d.hubStore,
    attachedHub: () => w.uplink.attachedHub(),
    attachedHubIdOf: (id) => {
      if (d.hub) return d.hub.uplink.attachments.attachedHubId(id) ?? null;
      const listed = state.lastNodeList?.nodes.find((node) => node.id === id);
      return listed?.attachedHubId ?? null;
    },
    hubMode: () => d.hub?.mode() ?? null,
    hubCandidates: () => w.uplink.candidates(),
    trustProxy: gatewayConfig.trustProxy,
    connectionLookup: (input) =>
      d.sessions.lookup(input.sid, input.via, input.connectionId, input.cid),
    // 本地浏览器 socket 由 MeshHttp 自己关，挂在 mesh 流上的这批只复验、失效的才拆。
    onSessionsRevoked: (target) => d.sessions.reverifyRevoked(target, d.verifyBoundSession),
  });
  http.auth.setTlsInfo(d.opts.tlsInfo);
  http.auth.setWriterForward((req, uid) => d.hub?.forwardWrite(req, uid) ?? Promise.resolve(null));
  wireRelayRoutes(http, { d, config, nodeId: identity.nodeIdHex, userStore, uplink });
  d.httpHolder.runtime = http;
  wireTransferBridge(identity.nodeIdHex, peers.transportOf, http.forwarder);
  setMeshAgentBridge({
    selfNodeId: identity.nodeIdHex,
    lookupNode(nodeId) {
      return lookupRemoteNode(
        nodeId,
        peers.listReach(),
        peers.listHubOnline?.() ?? new Set<string>()
      );
    },
    forwardInternalHttp: (nodeId, path, body, signal) =>
      http.forwarder.forwardInternalHttp(nodeId, path, body, signal),
    forwardAuthorizedHttp: (req, input) => http.forwarder.forwardAuthorizedHttp(req, input),
  });
  setMeshNotificationBridge(
    buildMeshNotificationBridge({
      selfNodeId: identity.nodeIdHex,
      selfName: () => selfDisplayNameOf(d),
      userStore,
      listReach: () => peers.listReach(),
      listHubOnline: () => peers.listHubOnline(),
      listedNodes: () => state.lastNodeList?.nodes ?? [],
      declaredSinks: () => listNotificationSinkNodeIds(d.userIdOf()),
      forwardInternalHttp: (nodeId, path, body, signal) =>
        http.forwarder.forwardInternalHttp(nodeId, path, body, signal),
    })
  );
  return http;
}
function createTlsRefresher(d: MeshDeps, uplink: UplinkPool): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const prev = d.state.caFingerprint;
      await d.refreshTls();
      d.hub?.updateSelfCaFingerprint(d.state.caFingerprint);
      if (d.state.caFingerprint !== prev) uplink.sendStatusIfChanged();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

/** 端口映射的入站放行按 nodeId 注册，链路直接复用本节点的 PeerManager。 */
function bindPortMaps(d: MeshDeps, peerManager: PeerManager): () => void {
  return bindPortMapNode(d.identity.nodeIdHex, {
    peers: peerManager,
    exports: new PortMapExportStore(d.db),
  });
}

function assembleMeshRuntime(
  d: MeshDeps,
  w: ReturnType<typeof wireMeshEventsAndSessions>,
  http: MeshHttpRuntime
): MeshRuntime {
  const { opts, config, identity, hub, sessions, userStore, rtc, bulk, state } = d;
  const { uplink, peerManager } = w;
  const unbindPortMap = bindPortMaps(d, peerManager);
  let stopPromise: Promise<void> | null = null;
  let stopReach: (() => void) | null = null;
  let tlsPoll: { clear: () => void } | null = null;
  const refreshTlsAndAdvertise = createTlsRefresher(d, uplink);
  const unsubscribeHubMode = hub?.onModeChange(() => uplink.sendStatusIfChanged()) ?? null;
  const runtime: MeshRuntime = {
    nodeId: identity.nodeIdHex,
    identity,
    hub,
    uplink,
    peers: peerManager,
    rtc,
    sessions,
    userStore,
    userKeyService: d.keyLogService,
    registerGatewaySession: (entry) => sessions.register(entry),
    unregisterGatewaySession(sidOrSession) {
      if (typeof sidOrSession === 'string') sessions.unregister(sidOrSession);
      else sessions.unregisterSession(sidOrSession);
    },
    get lastNodeList() {
      return state.lastNodeList;
    },
    set lastNodeList(value) {
      state.lastNodeList = value;
    },
    handleRequest: http.handleRequest.bind(http),
    invalidateAuthModeCache: () => http.auth.invalidateAuthModeCache(),
    localUiGuard: http.localUiGuard.bind(http),
    guardGatewayWebSocket: http.guardGatewayWebSocket.bind(http),
    rewriteSelf: http.rewriteSelf.bind(http),
    // 挂在 mesh 流上的会话由 MeshHttp 的 onSessionsRevoked 复核后处理，这里不再无条件拆。
    closeSocketsForUser: (uid) => http.closeSocketsForUser(uid),
    closeSocketsForSid: (sid) => http.closeSocketsForSid(sid),
    touchSocket: http.touchSocket.bind(http),
    websocket: {
      open: (ws) => http.handleWebSocket.open(ws),
      message: (ws, message) => http.handleWebSocket.message(ws, message),
      drain: (ws) => http.handleWebSocket.drain(ws),
      close: (ws, code, reason) => http.handleWebSocket.close(ws, code, reason),
    },
    onNodeEvent(cb) {
      d.nodeEvents.add(cb);
      return () => d.nodeEvents.delete(cb);
    },
    onNodeList(cb) {
      return uplink.onNodeList(cb);
    },
    attachedHub() {
      return uplink.attachedHub();
    },
    relayPresence: relayMultiAttachOf(d.relay)?.presence ?? null,
    relayOpener: relayMultiAttachOf(d.relay)?.opener ?? null,
    reconfigureUplink: () => reconfigureRelayUplink(d.relay, uplink),
    refreshTlsAndAdvertise,
    async start() {
      if (!d.userIdOf()) {
        const empty = userStore.listUsers().length === 0 && userStore.listCerts().length === 0;
        if (config.roles.hub && empty) {
          console.warn(
            '[mesh] starting hub uplink without resolved userId; key-log catch-up skipped until a unique user exists'
          );
        } else {
          console.error(
            '[mesh] refusing to start uplink: userId unresolved (empty or ambiguous across users/certs)'
          );
          return;
        }
      }
      if (opts.tlsInfo) {
        await refreshTlsAndAdvertise();
      }
      await d.relay.reconcileQuietly();
      await peerManager.start();
      stopReach = bootPortReach({
        startPeerServer: opts.startPeerServer,
        listenPort: peerManager.listenPort,
        selfNodeId: identity.nodeIdHex,
        userStore,
        now: () => d.scheduler.now(),
        previous: stopReach,
      });
      uplink.start();
      relayMultiAttachOf(d.relay)?.start();
      kickHubPeerDiscovery(hub, uplink);
      startMeshRtcProbes(rtc, d.scheduler);
      noteMeshStunConfig(d.state, d.config);
      tlsPoll = startTlsFingerprintPoll(opts, d.scheduler, refreshTlsAndAdvertise);
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        tlsPoll?.clear();
        tlsPoll = null;
        stopReach?.();
        stopReach = null;
        w.unsubscribeUplinkState();
        clearHubPresenceDecay(d.state);
        unsubscribeHubMode?.();
        d.nodeEventDedupe.clear();
        setMeshAgentBridge(null);
        setTransferMeshBridge(null);
        setMeshNotificationBridge(null);
        setMessagingMeshRuntime(null);
        await stopQuietly(meshStopTasksFor(d, peerManager, uplink, http, unbindPortMap));
      })();
      return stopPromise;
    },
  };
  setMessagingMeshRuntime(() => runtime);
  return runtime;
}

export async function createMeshRuntime(opts: CreateMeshRuntimeOptions): Promise<MeshRuntime> {
  const deps = await constructMeshDeps(opts);
  const wired = wireMeshEventsAndSessions(deps);
  const http = wireMeshHttp(deps, wired);
  return assembleMeshRuntime(deps, wired, http);
}
function resolveSiteName(): string {
  try {
    const saved = getSiteSettings().siteName?.trim();
    if (saved) return saved;
  } catch {}
  return gatewayConfig.siteNameDefault?.trim() ?? '';
}

function selfDisplayNameOf(d: MeshDeps): string | null {
  const id = d.identity.nodeIdHex;
  const listed = d.state.lastNodeList?.nodes.find((node) => node.id === id)?.name;
  return pickSelfDisplayName({
    id,
    listedName: listed,
    registryName: d.userStore.getNode(id)?.name,
    identityName: d.relay.secrets.store.localName(),
    siteName: resolveSiteName(),
  });
}
