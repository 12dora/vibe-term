import os from 'node:os';
import { canonicalHubUrl, encodeBase64url } from '@tmex/shared/auth';
import { type LinkSession, createInMemoryLinkPair } from '@tmex/shared/link';
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
  makeVerifyPasskeyAssertion,
} from '../auth';
import { HubTrustStore } from '../auth/hub-trust-store';
import type { AuthDb } from '../auth/types';
import { HUB_META_PEER_ID } from '../auth/user-store';
import { type TmexRoles, config as gatewayConfig } from '../config';
import { HubRuntime, type HubTurnConfig } from '../hub';
import { createHubKeyLogSource } from '../hub/hub-key-log-source';
import type { HubTlsInfoProvider } from '../hub/hub-runtime';
import type { GatewayRuntime } from '../runtime';
import { getDisplayVersion } from '../system/version';
import type { GatewaySession } from '../ws/gateway-session';
import { defaultScheduler, encodeJsonBytes } from './ctl';
import {
  type CachedRtcConfig,
  type ConnectionLookupResult,
  type KeyLogPublisher,
  MESH_VIA_SELF,
  type MeshHandleResult,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type NodeEventPayload,
  type OpenedWsStream,
  type PeerLinkProvider,
  type RtcFingerprintProvider,
  type RtcSignalMessage,
  type StreamOpener,
  WS_CLOSE_LOGIN_REQUIRED,
  getMeshRequestContext,
  requestDispatchContext,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { NodeEventDedupe, type NodeEventProjection } from './node-event-dedupe';
import { type PeerLinkFactory, PeerManager } from './peer-manager';
import {
  type ControlSendStatus,
  type LoadNative,
  MeshRtcSignalRouter,
  RtcPeerManager,
} from './rtc';
import { BulkTransferService, parseBulkChannelLabel } from './rtc/bulk';
import { authenticateRequest } from './session-middleware';
import { openHttpStream, openWsStream } from './stream-targets';
import type { DispatchContext, KeyLogApplier, MeshScheduler, PeerBindHost } from './types';
import { UplinkClient, type UplinkWsFactory } from './uplink-client';
import type { UplinkNodeList, UplinkRtcSignal } from './uplink-protocol';

export type MeshRuntimeConfig = {
  roles: TmexRoles;
  hubUrl: string | null;
  hubPublicUrl?: string | null;
  peerPort: number;
  stunServers: string[];
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
  hub?: HubRuntime;
  /** Same-process hub to attach an in-memory uplink to (remote node in hub+A+B tests). */
  uplinkHub?: HubRuntime;
  wsFactory?: UplinkWsFactory;
  peerHostname?: PeerBindHost;
  startPeerServer?: boolean;
  pingIntervalMs?: number;
  scheduler?: MeshScheduler;
  userId?: string;
  loadNative?: LoadNative;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  linkFactory?: PeerLinkFactory;
  rtcHandshakeTimeoutMs?: number;
  tlsInfo?: HubTlsInfoProvider;
};

export const CONNECTION_ID_BYTES = 32;

export function generateConnectionId(): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(CONNECTION_ID_BYTES)));
}

export type RegisteredGatewaySession = {
  connectionId: string;
  cid?: string;
  sid: string;
  uid: string;
  via: string;
  session: GatewaySession;
  lastVerifyAt: number;
  pc?: { close(): void };
};

export type RegisterGatewaySessionInput = {
  sid: string;
  uid: string;
  via: string;
  session: GatewaySession;
  connectionId?: string;
  cid?: string;
  pc?: { close(): void };
};

export type RegisterGatewaySessionResult =
  | { ok: true; entry: RegisteredGatewaySession }
  | { ok: false; code: 'DUPLICATE_CONNECTION' | 'DUPLICATE_CID' };

function cidIndexKey(sid: string, via: string, cid: string): string {
  return `${sid}\0${via}\0${cid}`;
}

function normalizeCid(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class SessionRegistry {
  private readonly byConnection = new Map<string, RegisteredGatewaySession>();
  private readonly bySession = new WeakMap<GatewaySession, string>();
  private readonly connectionsBySid = new Map<string, Set<string>>();
  private readonly byCid = new Map<string, string>();

  register(entry: RegisterGatewaySessionInput): RegisterGatewaySessionResult {
    const cid = normalizeCid(entry.cid);
    const providedId = typeof entry.connectionId === 'string' ? entry.connectionId.trim() : '';
    const taken = (id: string | undefined) => {
      const e = id ? this.byConnection.get(id) : undefined;
      return Boolean(e && e.session !== entry.session && !e.session.closed);
    };
    if (providedId && taken(providedId)) return { ok: false, code: 'DUPLICATE_CONNECTION' };
    if (cid && taken(this.byCid.get(cidIndexKey(entry.sid, entry.via, cid)))) {
      return { ok: false, code: 'DUPLICATE_CID' };
    }
    let connectionId = providedId;
    if (!connectionId) {
      do {
        connectionId = generateConnectionId();
      } while (this.byConnection.has(connectionId));
    }
    const prevSame = this.byConnection.get(connectionId);
    if (prevSame?.session === entry.session) this.drop(prevSame);
    const stored: RegisteredGatewaySession = {
      connectionId,
      sid: entry.sid,
      uid: entry.uid,
      via: entry.via,
      session: entry.session,
      lastVerifyAt: 0,
      ...(cid ? { cid } : {}),
      ...(entry.pc ? { pc: entry.pc } : {}),
    };
    this.byConnection.set(connectionId, stored);
    this.bySession.set(entry.session, connectionId);
    let set = this.connectionsBySid.get(entry.sid);
    if (!set) {
      set = new Set();
      this.connectionsBySid.set(entry.sid, set);
    }
    set.add(connectionId);
    if (cid) this.byCid.set(cidIndexKey(entry.sid, entry.via, cid), connectionId);
    return { ok: true, entry: stored };
  }

  unregister(sid: string, session?: GatewaySession): void {
    if (session) {
      this.unregisterSession(session);
      return;
    }
    for (const entry of this.listBySid(sid)) this.drop(entry);
  }

  unregisterSession(session: GatewaySession): void {
    const connectionId = this.bySession.get(session);
    if (!connectionId) return;
    const entry = this.byConnection.get(connectionId);
    if (entry) this.drop(entry);
  }

  get(sid: string): RegisteredGatewaySession | null {
    const live = this.listBySid(sid);
    return live.length === 1 ? (live[0] ?? null) : null;
  }

  getByConnectionId(connectionId: string): RegisteredGatewaySession | null {
    const entry = this.byConnection.get(connectionId);
    if (!entry || entry.session.closed) return null;
    return entry;
  }

  getBySession(session: GatewaySession): RegisteredGatewaySession | null {
    const connectionId = this.bySession.get(session);
    return connectionId ? this.getByConnectionId(connectionId) : null;
  }

  listBySid(sid: string): RegisteredGatewaySession[] {
    const ids = this.connectionsBySid.get(sid);
    if (!ids) return [];
    const out: RegisteredGatewaySession[] = [];
    for (const id of ids) {
      const entry = this.byConnection.get(id);
      if (entry && !entry.session.closed) out.push(entry);
    }
    return out;
  }

  listByUid(uid: string): RegisteredGatewaySession[] {
    const out: RegisteredGatewaySession[] = [];
    for (const entry of this.byConnection.values()) {
      if (entry.uid === uid && !entry.session.closed) out.push(entry);
    }
    return out;
  }

  lookup(
    sid: string,
    via: string,
    connectionId?: string | null,
    cid?: string | null
  ): ConnectionLookupResult {
    const nonce = normalizeCid(cid);
    if (nonce || connectionId) {
      const id = nonce ? this.byCid.get(cidIndexKey(sid, via, nonce)) : connectionId;
      const entry = id ? this.getByConnectionId(id) : null;
      return entry && entry.sid === sid && entry.via === via
        ? { ok: true, connectionId: entry.connectionId }
        : { ok: false, code: 'NO_CONNECTION' };
    }
    const matches = this.listBySid(sid).filter((entry) => entry.via === via);
    if (matches.length === 0) return { ok: false, code: 'NO_CONNECTION' };
    if (matches.length > 1) return { ok: false, code: 'MULTIPLE_CONNECTIONS' };
    const only = matches[0];
    if (!only) return { ok: false, code: 'NO_CONNECTION' };
    return { ok: true, connectionId: only.connectionId };
  }

  private drop(entry: RegisteredGatewaySession): void {
    this.byConnection.delete(entry.connectionId);
    this.bySession.delete(entry.session);
    if (entry.cid) this.byCid.delete(cidIndexKey(entry.sid, entry.via, entry.cid));
    const set = this.connectionsBySid.get(entry.sid);
    if (!set) return;
    set.delete(entry.connectionId);
    if (set.size === 0) this.connectionsBySid.delete(entry.sid);
  }
}

export type MeshRuntime = {
  readonly nodeId: string;
  readonly identity: NodeIdentityKeys;
  readonly hub: HubRuntime | null;
  readonly uplink: UplinkClient;
  readonly peers: PeerManager;
  readonly rtc: RtcPeerManager;
  readonly sessions: SessionRegistry;
  readonly userStore: UserStore;
  readonly userKeyService: UserKeyService;
  lastNodeList: UplinkNodeList | null;
  registerGatewaySession(entry: RegisterGatewaySessionInput): RegisterGatewaySessionResult;
  unregisterGatewaySession(sidOrSession: string | GatewaySession): void;
  handleRequest(req: Request, server: MeshUpgradeServer): Promise<MeshHandleResult>;
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
};

export type NetworkInterfacesFn = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

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

function parseIpv6Words(address: string): number[] | null {
  const bare = stripZoneId(address).toLowerCase();
  if (bare.includes('.')) return null;
  const compressed = bare.split('::');
  if (compressed.length > 2) return null;
  const parseGroup = (raw: string): number[] | null => {
    if (!raw) return [];
    const parts = raw.split(':');
    const words: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      words.push(Number.parseInt(part, 16));
    }
    return words;
  };
  if (compressed.length === 1) {
    const words = parseGroup(compressed[0] ?? '');
    return words && words.length === 8 ? words : null;
  }
  const left = parseGroup(compressed[0] ?? '');
  const right = parseGroup(compressed[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

export function isAdvertisablePeerAddress(addr: os.NetworkInterfaceInfo): boolean {
  if (addr.internal) return false;
  const family = addr.family as string | number;
  if (family === 'IPv4' || family === 4) {
    const o = parseIpv4Octets(stripZoneId(addr.address));
    if (!o) return false;
    const a = o[0] ?? 0;
    const b = o[1] ?? 0;
    return !(
      o.every((n) => n === 0) ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a >= 224 && a <= 239)
    );
  }
  if (family === 'IPv6' || family === 6) {
    const w = parseIpv6Words(addr.address);
    if (!w) return false;
    const w0 = w[0] ?? 0;
    return !(
      (w.slice(0, 7).every((x) => x === 0) && (w[7] ?? 0) <= 1) ||
      (w0 & 0xffc0) === 0xfe80 ||
      (w0 & 0xff00) === 0xff00
    );
  }
  return false;
}

export function enumeratePeerEndpoints(
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!isAdvertisablePeerAddress(addr)) continue;
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
  if (config.turnUrl && config.turnUsername && config.turnCredential) {
    return {
      url: config.turnUrl,
      username: config.turnUsername,
      credential: config.turnCredential,
    };
  }
  return null;
}

function createKeyLogApplier(keys: UserKeyService): KeyLogApplier {
  return {
    head: (userId, signal) => keys.head(userId, signal),
    list: (userId, fromSeq, signal, limit) => keys.list(userId, fromSeq, signal, limit),
    async applyMany(userId, records, signal) {
      const result = await keys.applyMany(userId, records, signal);
      return result.ok
        ? { applied: result.applied }
        : { applied: result.applied, error: result.error };
    },
  };
}

async function openAdaptedWsStream(
  link: LinkSession,
  auth: string,
  cid?: string
): Promise<OpenedWsStream> {
  const opened = await openWsStream(link, auth, cid);
  const messageCbs: Array<(bytes: Uint8Array) => void> = [];
  const closeCbs: Array<(info: { code?: number; reason?: string }) => void> = [];
  let closed = false;
  const notifyClose = (info: { code?: number; reason?: string }) => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) {
      try {
        cb(info);
      } catch {}
    }
  };
  const reader = opened.readable.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) for (const cb of messageCbs) cb(value);
      }
      notifyClose({});
    } catch {
      notifyClose({ code: 1011, reason: 'stream-error' });
    }
  })();
  opened.stream.onAbort(() => notifyClose({ code: 1011, reason: 'reset' }));
  return {
    send(bytes) {
      void opened.send(bytes);
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close(_code, reason) {
      try {
        opened.close();
      } catch {}
      notifyClose({ reason });
    },
  };
}

export function resolveUserId(
  userStore: UserStore,
  nodeIdHex: string,
  explicit?: string
): string | null {
  if (explicit) return explicit;
  const self = userStore.getCert(nodeIdHex);
  if (self?.userId) return self.userId;
  const ids = new Set<string>();
  for (const user of userStore.listUsers()) {
    if (user.id) ids.add(user.id);
  }
  for (const cert of userStore.listCerts()) {
    if (cert.userId) ids.add(cert.userId);
  }
  if (ids.size !== 1) return null;
  const only = ids.values().next().value;
  return typeof only === 'string' && only.length > 0 ? only : null;
}

function hubEndpointUrl(config: MeshRuntimeConfig): string {
  return (
    (config.roles.hub ? (config.hubPublicUrl ?? config.hubUrl) : config.hubUrl) ??
    'http://127.0.0.1'
  );
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
      console.error(`[tmex] ${label} stop failed`, err);
    }
  }
}

async function constructMeshDeps(opts: CreateMeshRuntimeOptions) {
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
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const applier = createKeyLogApplier(keyLogService);
  const userIdOf = () => resolveUserId(userStore, identity.nodeIdHex, opts.userId) ?? '';
  const nodeEvents = new Set<(event: NodeEventPayload) => void>();
  const nodeEventDedupe = new NodeEventDedupe();
  const state = {
    lastRtc: (config.stunServers.length
      ? { stun: config.stunServers, turn: turnConfig(config) }
      : null) as CachedRtcConfig | null,
    lastNodeList: null as UplinkNodeList | null,
    hubPresenceLive: false,
    hubGeneration: 0,
  };
  const emitNodeEvent = (event: NodeEventPayload) => {
    for (const cb of nodeEvents) {
      try {
        cb(event);
      } catch {}
    }
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
          turn: (turnConfig(config) as HubTurnConfig) ?? null,
          nodeId: identity.nodeIdHex,
          siteName: gatewayConfig.siteNameDefault,
        },
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
      }))
    : (opts.hub ?? null);

  const peerHolder: { manager: PeerManager | null } = { manager: null };
  const innerSignalsHolder: { router: MeshRtcSignalRouter | null } = { router: null };
  const startBrowserAcceptHolder: { fn: (rtcSession: string) => void } = { fn() {} };
  const httpHolder: { runtime: MeshHttpRuntime | null } = { runtime: null };
  const interfacesFn = opts.networkInterfaces ?? os.networkInterfaces;
  const loadNative: LoadNative = opts.loadNative ?? (async () => null);
  const sessions = new SessionRegistry();
  const bulk = new BulkTransferService({ files: filesBulkHooks });
  const acceptingBrowser = new Set<string>();
  const rtc = new RtcPeerManager({
    loadNative,
    iceConfigProvider: () =>
      state.lastRtc ?? { stun: config.stunServers, turn: turnConfig(config) },
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore,
    handshakeTimeoutMs: opts.rtcHandshakeTimeoutMs,
    sendControl: (session, kind, payload) => sendControl(gateway, session, kind, payload),
    deliverInbound: (session, bytes) => {
      const entry = sessions.getBySession(session);
      if (!entry || !verifyBoundSession(entry)) return;
      try {
        gateway.wsServer.handleMessage(session, Buffer.from(bytes));
      } catch {}
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
  function verifyBoundSession(entry: RegisteredGatewaySession): boolean {
    if (entry.session.closed) {
      teardownBinding(entry);
      return false;
    }
    const now = Date.now();
    const verified = nodeSessionStore.verify(entry.sid, { viaNodeId: entry.via, now });
    if (!verified.ok) {
      teardownBinding(entry);
      return false;
    }
    entry.lastVerifyAt = now;
    return true;
  }
  function teardownBinding(entry: RegisteredGatewaySession): void {
    if (tearingDown.has(entry.session)) return;
    tearingDown.add(entry.session);
    sessions.unregisterSession(entry.session);
    rtc.notifySessionClosed(entry.session);
    try {
      entry.pc?.close();
    } catch {}
    bulk.abortByOwner(entry.connectionId);
    if (!entry.session.closed && typeof wsServer.closeSession === 'function') {
      try {
        wsServer.closeSession(entry.session, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      } catch {}
    }
  }
  const scheduler = opts.scheduler ?? defaultScheduler();
  const statusProvider = () => {
    const version = getDisplayVersion();
    return {
      version,
      tmux: true,
      direct_capable: rtc.available,
      inventory: { version },
      endpoints: enumeratePeerEndpoints(
        peerHolder.manager?.listenPort ?? config.peerPort,
        interfacesFn()
      ),
    };
  };
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
    peerHolder,
    innerSignalsHolder,
    startBrowserAcceptHolder,
    httpHolder,
    sessions,
    bulk,
    acceptingBrowser,
    rtc,
    verifyBoundSession,
    teardownBinding,
    scheduler,
    statusProvider,
  };
}

function wireMeshEventsAndSessions(d: Awaited<ReturnType<typeof constructMeshDeps>>) {
  const { opts, config, identity, userStore, state, rtc, sessions, hub, bulk } = d;
  const hubTrust = config.hubUrl ? new HubTrustStore(d.db).get(config.hubUrl) : null;
  if (config.hubUrl && !hubTrust?.caPem) {
    let label = config.hubUrl;
    try {
      label = canonicalHubUrl(config.hubUrl);
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
  const uplink = new UplinkClient({
    hubUrl: hubEndpointUrl(config),
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userId: d.userIdOf,
    keyLogApplier: d.applier,
    userStore,
    statusProvider: d.statusProvider,
    wsFactory: opts.wsFactory,
    tlsCa: hubTrust?.caPem ? [hubTrust.caPem] : null,
    scheduler: d.scheduler,
    pingIntervalMs: opts.pingIntervalMs,
    onEnrollRedeemed: (msg) => {
      d.httpHolder.runtime?.mesh.forwardEnrollRedeemed({
        enrollPk: msg.enroll_pk,
        certificate: msg.certificate,
        certSig: msg.cert_sig,
        nodeId: msg.nodeId,
        entrySid: msg.entrySid,
      });
    },
    onNodeList: (list) => {
      state.lastNodeList = list;
      if (!state.hubPresenceLive) state.hubGeneration += 1;
      state.hubPresenceLive = true;
      state.lastRtc = { stun: list.rtc.stun, turn: list.rtc.turn ?? null };
      const reach = d.peerHolder.manager?.listReach() ?? new Map();
      const hubId = list.hub?.nodeId ?? null;
      for (const node of list.nodes) {
        if (node.id === HUB_META_PEER_ID) continue;
        if (rejectPeer(node.id, true)) continue;
        d.emitListNodeEvent({
          nodeId: node.id,
          status: node.online ? 'online' : 'offline',
          reach: reach.get(node.id) ?? null,
          inventory:
            typeof node.inventory === 'string'
              ? node.inventory
              : JSON.stringify(node.inventory ?? null),
          version: node.version,
          direct_capable: node.direct_capable,
          name: node.name,
        });
        if (node.id !== identity.nodeIdHex)
          d.peerHolder.manager?.notifyPeerEndpointsChanged(node.id);
      }
      if (
        hubId &&
        hubId !== identity.nodeIdHex &&
        hubId !== HUB_META_PEER_ID &&
        !list.nodes.some((node) => node.id === hubId)
      ) {
        const cert = userStore.getCert(hubId);
        const uid = d.userIdOf();
        if (cert && uid && cert.userId === uid && cert.revokedLogSeq == null) {
          d.emitListNodeEvent({
            nodeId: hubId,
            status: 'online',
            reach: reach.get(hubId) ?? null,
            name: list.hub?.name,
          });
        }
      }
      for (const peer of userStore.listPeers()) {
        if (
          peer.nodeId === identity.nodeIdHex ||
          peer.nodeId === HUB_META_PEER_ID ||
          peer.nodeId === hubId
        ) {
          continue;
        }
        rejectPeer(peer.nodeId, false);
      }
    },
    onRtcSignal: (msg: UplinkRtcSignal) => {
      const signal: RtcSignalMessage = {
        rtcSession: msg.rtcSession,
        from: msg.from,
        to: msg.to,
        sdp: msg.sdp,
        candidate: msg.candidate,
      };
      const dcPeer = peerFromDcSession(identity.nodeIdHex, msg.rtcSession);
      if (dcPeer) d.peerHolder.manager?.receiveRtcSignal(dcPeer, signal);
      if (signal.from === 'browser') {
        d.innerSignalsHolder.router?.deliverLocal(signal);
        d.startBrowserAcceptHolder.fn(signal.rtcSession);
      }
      for (const cb of d.signalListeners) {
        try {
          cb(signal);
        } catch {}
      }
    },
  });
  const noopUpgrade: MeshUpgradeServer = { upgrade: () => false };
  const dispatchInboundHttp = async (request: Request, ctx: DispatchContext): Promise<Response> => {
    const trusted = requestDispatchContext.get(request);
    const via = trusted?.viaNodeId ?? ctx.viaNodeId;
    const uid = trusted?.uid ?? ctx.uid;
    const renewedExpiresAt = trusted?.renewedExpiresAt ?? ctx.renewedExpiresAt;
    const extra = renewedExpiresAt !== undefined ? { renewedExpiresAt } : {};
    setMeshRequestContext(request, { via, uid, clientIp: `peer:${via}`, ...extra });
    requestDispatchContext.set(request, { uid, viaNodeId: via, ...extra });
    const meshHttp = d.httpHolder.runtime;
    if (meshHttp) {
      const meshRes = await meshHttp.handleRequest(request, noopUpgrade);
      if (meshRes instanceof Response) return meshRes;
    }
    if (config.roles.hub && hub) {
      const hubRes = await hub.handleRequest(request, noopUpgrade);
      if (hubRes instanceof Response) return hubRes;
    }
    return d.gateway.dispatchHttp(request, { uid, viaNodeId: via, ...extra });
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
    onGatewaySession: (session, auth) => sessions.register({ ...auth, session }).ok,
    onGatewaySessionClose: (session) => {
      const entry = sessions.getBySession(session);
      if (entry) d.teardownBinding(entry);
      else sessions.unregisterSession(session);
    },
    onBrowserSignal: (signal, fromNodeId) => {
      d.innerSignalsHolder.router?.deliverLocal(signal, fromNodeId);
      d.startBrowserAcceptHolder.fn(signal.rtcSession);
    },
    ensureDcSession: ensureDc,
  });
  d.peerHolder.manager = peerManager;
  uplink.onStateChange((liveState) => {
    const live = liveState === 'online';
    if (state.hubPresenceLive && !live && state.lastNodeList) {
      const reach = peerManager.listReach();
      for (const node of state.lastNodeList.nodes) {
        if (node.id === identity.nodeIdHex || !node.online) continue;
        const r = reach.get(node.id);
        if (r === 'lan' || r === 'relay') continue;
        d.emitSyntheticOffline(node.id);
      }
    }
    if (!live) state.hubPresenceLive = false;
  });
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
        uplink.sendCtl(rtcSignalCtl(msg));
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
      send: (msg: RtcSignalMessage) => {
        innerSignals.send(msg);
      },
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
  return { uplink, peerManager, fingerprint, signals };
}

function wireMeshHttp(
  d: Awaited<ReturnType<typeof constructMeshDeps>>,
  w: ReturnType<typeof wireMeshEventsAndSessions>
): MeshHttpRuntime {
  const { config, identity, userStore, state } = d;
  const { uplink, peerManager, fingerprint, signals } = w;
  const peers: PeerLinkProvider = {
    getLink: (nodeId) => peerManager.getLink(nodeId),
    listReach: () => peerManager.listReach(),
    transportOf: (nodeId) => peerManager.transportOf(nodeId),
    listHubOnline: () => {
      const ids = new Set<string>();
      if (!state.hubPresenceLive || uplink.state !== 'online' || !state.lastNodeList) return ids;
      for (const node of state.lastNodeList.nodes) {
        if (node.online) ids.add(node.id);
      }
      return ids;
    },
    onNodeEvent: (cb) => {
      d.nodeEvents.add(cb);
      return () => {
        d.nodeEvents.delete(cb);
      };
    },
  };
  const streams: StreamOpener = {
    openHttpStream: (link, open, body, signal) =>
      openHttpStream(link, { type: 'http', ...open }, body, signal),
    openWsStream: (link, auth, cid) => openAdaptedWsStream(link, auth, cid),
  };
  const publisher: KeyLogPublisher = {
    publish(record) {
      try {
        uplink.sendCtl({ t: 'key.log.append', bytes: record.bytes, sig: record.sig });
      } catch {}
    },
    async publishAndAck(record) {
      const ack = await uplink.appendAndAck(record);
      if (ack.ok) return { ok: true, seq: ack.seq ?? 0n };
      return { ok: false, error: ack.error ?? 'hub_error' };
    },
    queryHubHead: () => uplink.queryHubHead(),
    queryKeyLogAt: (seq) => uplink.queryKeyLogAt(seq),
  };
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
      config: { getRtcConfig: () => state.lastRtc },
    },
    selfStatus: d.statusProvider,
    listedNames: () => {
      const rows: Array<{ id: string; name: string }> = [];
      if (!state.lastNodeList) return rows;
      for (const node of state.lastNodeList.nodes) rows.push({ id: node.id, name: node.name });
      if (state.lastNodeList.hub?.name) {
        rows.push({ id: state.lastNodeList.hub.nodeId, name: state.lastNodeList.hub.name });
      }
      return rows;
    },
    selfName: () => {
      const listed = state.lastNodeList?.nodes.find((node) => node.id === identity.nodeIdHex)?.name;
      if (listed && listed !== identity.nodeIdHex && listed !== 'self') return listed;
      const row = userStore.getNode(identity.nodeIdHex);
      if (row?.name && row.name !== identity.nodeIdHex) return row.name;
      if (config.roles.hub) {
        const site = gatewayConfig.siteNameDefault?.trim();
        if (site) return site;
      }
      return listed && listed !== 'self' ? listed : null;
    },
    primaryUserId: d.userIdOf() || undefined,
    hubPublicUrl: hubEndpointUrl(config),
    trustProxy: gatewayConfig.trustProxy,
    connectionLookup: (input) =>
      d.sessions.lookup(input.sid, input.via, input.connectionId, input.cid),
  });
  http.auth.setTlsInfo(d.opts.tlsInfo);
  d.httpHolder.runtime = http;
  return http;
}

function assembleMeshRuntime(
  d: Awaited<ReturnType<typeof constructMeshDeps>>,
  w: ReturnType<typeof wireMeshEventsAndSessions>,
  http: MeshHttpRuntime
): MeshRuntime {
  const { opts, config, identity, hub, sessions, userStore, rtc, bulk, state } = d;
  const { uplink, peerManager } = w;
  const uplinkHub = hub ?? opts.uplinkHub ?? null;
  let stopPromise: Promise<void> | null = null;
  return {
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
    localUiGuard: http.localUiGuard.bind(http),
    guardGatewayWebSocket: http.guardGatewayWebSocket.bind(http),
    rewriteSelf: http.rewriteSelf.bind(http),
    closeSocketsForUser: (uid) => {
      http.closeSocketsForUser(uid);
      for (const entry of sessions.listByUid(uid)) d.teardownBinding(entry);
    },
    closeSocketsForSid: (sid) => {
      http.closeSocketsForSid(sid);
      for (const entry of sessions.listBySid(sid)) d.teardownBinding(entry);
    },
    touchSocket: http.touchSocket.bind(http),
    websocket: {
      open: (ws) => http.handleWebSocket.open(ws),
      message: (ws, message) => http.handleWebSocket.message(ws, message),
      drain() {},
      close: (ws, code, reason) => http.handleWebSocket.close(ws, code, reason),
    },
    onNodeEvent(cb) {
      d.nodeEvents.add(cb);
      return () => {
        d.nodeEvents.delete(cb);
      };
    },
    async start() {
      await rtc.ready();
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
      await peerManager.start();
      if (uplinkHub) {
        const target = uplinkHub;
        uplink.start(async (signal) => {
          const [nodeLink, hubLink] = createInMemoryLinkPair();
          const online = uplink.connectWithLink(nodeLink, signal);
          target.attachLocalNode(hubLink);
          await online;
        });
      } else {
        uplink.start();
      }
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        d.nodeEventDedupe.clear();
        await stopQuietly([
          ['peer', () => peerManager.stop()],
          ['uplink', () => uplink.stop()],
          ['mesh http', () => http.stop()],
          ['rtc', () => rtc.close()],
          ['bulk', () => bulk.close()],
        ]);
      })();
      return stopPromise;
    },
  };
}

export async function createMeshRuntime(opts: CreateMeshRuntimeOptions): Promise<MeshRuntime> {
  const deps = await constructMeshDeps(opts);
  const wired = wireMeshEventsAndSessions(deps);
  const http = wireMeshHttp(deps, wired);
  return assembleMeshRuntime(deps, wired, http);
}
