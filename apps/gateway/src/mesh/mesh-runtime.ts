import os from 'node:os';
import { encodeBase64url } from '@tmex/shared/auth';
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
import type { AuthDb } from '../auth/types';
import { HUB_META_PEER_ID } from '../auth/user-store';
import { type TmexRoles, config as gatewayConfig } from '../config';
import { HubRuntime, type HubTurnConfig } from '../hub';
import { createHubKeyLogSource } from '../hub/hub-key-log-source';
import type { GatewayRuntime } from '../runtime';
import { getDisplayVersion } from '../system/version';
import type { GatewaySession } from '../ws/gateway-session';
import { encodeJsonBytes } from './ctl';
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

const ZERO_HASH = new Uint8Array(32);

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
    const providedId =
      typeof entry.connectionId === 'string' && entry.connectionId.trim()
        ? entry.connectionId.trim()
        : '';
    if (providedId) {
      const prev = this.byConnection.get(providedId);
      if (prev && prev.session !== entry.session && !prev.session.closed) {
        return { ok: false, code: 'DUPLICATE_CONNECTION' };
      }
    }
    if (cid) {
      const existingId = this.byCid.get(cidIndexKey(entry.sid, entry.via, cid));
      if (existingId) {
        const existing = this.byConnection.get(existingId);
        if (existing && existing.session !== entry.session && !existing.session.closed) {
          return { ok: false, code: 'DUPLICATE_CID' };
        }
      }
    }
    let connectionId = providedId;
    if (!connectionId) {
      do {
        connectionId = generateConnectionId();
      } while (this.byConnection.has(connectionId));
    }
    const prevSame = this.byConnection.get(connectionId);
    if (prevSame && prevSame.session === entry.session) {
      this.drop(prevSame);
    }
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
    for (const entry of this.listBySid(sid)) {
      this.drop(entry);
    }
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
    if (nonce) {
      const id = this.byCid.get(cidIndexKey(sid, via, nonce));
      if (!id) return { ok: false, code: 'NO_CONNECTION' };
      const entry = this.getByConnectionId(id);
      if (entry && entry.sid === sid && entry.via === via) {
        return { ok: true, connectionId: entry.connectionId };
      }
      return { ok: false, code: 'NO_CONNECTION' };
    }
    if (connectionId) {
      const entry = this.getByConnectionId(connectionId);
      if (entry && entry.sid === sid && entry.via === via) {
        return { ok: true, connectionId: entry.connectionId };
      }
      return { ok: false, code: 'NO_CONNECTION' };
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
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
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
  const isV4 = family === 'IPv4' || family === 4;
  const isV6 = family === 'IPv6' || family === 6;
  if (isV4) {
    const octets = parseIpv4Octets(stripZoneId(addr.address));
    if (!octets) return false;
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    if (a === 0 && b === 0 && (octets[2] ?? 0) === 0 && (octets[3] ?? 0) === 0) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a >= 224 && a <= 239) return false;
    return true;
  }
  if (isV6) {
    const words = parseIpv6Words(addr.address);
    if (!words) return false;
    if (words.every((w) => w === 0)) return false;
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return false;
    const w0 = words[0] ?? 0;
    if ((w0 & 0xffc0) === 0xfe80) return false;
    if ((w0 & 0xff00) === 0xff00) return false;
    return true;
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
      const isV6 = family === 'IPv6' || family === 6;
      const host = isV6 ? `[${stripZoneId(addr.address)}]` : stripZoneId(addr.address);
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

function splitPeerBindHosts(value: string | string[]): string[] {
  const parts = Array.isArray(value) ? value : value.split(',');
  const hosts = parts.map((item) => item.trim()).filter((item) => item.length > 0);
  return hosts.length > 0 ? hosts : [...gatewayConfig.peerBindHost];
}

function resolvePeerBindHost(
  explicit?: string | string[],
  fromConfig?: string | string[]
): string[] {
  if (explicit !== undefined) return splitPeerBindHosts(explicit);
  if (fromConfig !== undefined) return splitPeerBindHosts(fromConfig);
  return [...gatewayConfig.peerBindHost];
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

function createKeyLogApplier(keyLogStore: KeyLogStore, keys: UserKeyService): KeyLogApplier {
  return {
    async head(userId) {
      return keyLogStore.head(userId) ?? { seq: 0n, hash: ZERO_HASH };
    },
    async applyMany(userId, records) {
      const result = await keys.applyMany(userId, records);
      if (!result.ok) {
        return { applied: result.applied, error: result.error };
      }
      return { applied: result.applied };
    },
    async list(userId, fromSeq) {
      return keyLogStore.list(userId, Number(fromSeq)).map((row) => ({
        seq: BigInt(row.seq),
        bytes: row.bytes,
        sig: row.sig,
      }));
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
      } catch {
        // listener errors must not break the pump
      }
    }
  };
  const reader = opened.readable.getReader();
  void (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          for (const cb of messageCbs) cb(value);
        }
      }
      notifyClose({});
    } catch {
      notifyClose({ code: 1011, reason: 'stream-error' });
    }
  })();
  opened.stream.onAbort(() => {
    notifyClose({ code: 1011, reason: 'reset' });
  });
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
      } catch {
        // already closed
      }
      notifyClose({ reason });
    },
  };
}

function resolveUserId(userStore: UserStore, nodeIdHex: string, explicit?: string): string {
  if (explicit) return explicit;
  return userStore.getCert(nodeIdHex)?.userId ?? '';
}

function hubEndpointUrl(config: MeshRuntimeConfig): string {
  if (config.roles.hub) {
    return config.hubPublicUrl ?? config.hubUrl ?? 'http://127.0.0.1';
  }
  return config.hubUrl ?? 'http://127.0.0.1';
}

export async function createMeshRuntime(opts: CreateMeshRuntimeOptions): Promise<MeshRuntime> {
  const { db, gateway, config } = opts;
  const userStore = new UserStore(db);
  const keyLogStore = new KeyLogStore(db);
  const nodeSessionStore = new NodeSessionStore(db);
  const challengeStore = new ChallengeStore();
  const identityStore = new NodeIdentityStore(db);
  const identity = await ensureNodeIdentity(identityStore, {
    hubUrl: config.hubUrl ?? undefined,
  });
  const keyLogService = new UserKeyService({
    db,
    userStore,
    keyLogStore,
    nodeSessionStore,
    verifyPasskeyAssertion: makeVerifyPasskeyAssertion(userStore),
  });
  const applier = createKeyLogApplier(keyLogStore, keyLogService);
  const userId = resolveUserId(userStore, identity.nodeIdHex, opts.userId);
  const nodeEvents = new Set<(event: NodeEventPayload) => void>();
  const emitNodeEvent = (event: NodeEventPayload) => {
    for (const cb of nodeEvents) {
      try {
        cb(event);
      } catch {
        // listener errors must not break broadcast
      }
    }
  };
  const signalListeners = new Set<(signal: RtcSignalMessage) => void>();
  let lastNodeList: UplinkNodeList | null = null;
  let lastRtc: CachedRtcConfig | null = config.stunServers.length
    ? { stun: config.stunServers, turn: turnConfig(config) }
    : null;

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
        },
        authenticate: (req) => {
          const result = authenticateRequest(req, {
            roles: config.roles,
            nodeSessionStore,
          });
          if (!result.ok || !result.userId) return null;
          const via = getMeshRequestContext(req).via ?? MESH_VIA_SELF;
          return {
            userId: result.userId,
            entryNodeId: via === MESH_VIA_SELF ? identity.nodeIdHex : via,
            sid: result.sid,
          };
        },
      }))
    : (opts.hub ?? null);

  const peerHolder: { manager: PeerManager | null } = { manager: null };
  const innerSignalsHolder: { router: MeshRtcSignalRouter | null } = { router: null };
  const startBrowserAcceptHolder: { fn: (rtcSession: string) => void } = { fn() {} };
  const interfacesFn = opts.networkInterfaces ?? os.networkInterfaces;
  const loadNative: LoadNative = opts.loadNative ?? (async () => null);

  const sessions = new SessionRegistry();
  const bulk = new BulkTransferService({ files: filesBulkHooks });
  const acceptingBrowser = new Set<string>();

  const sendControl = (
    session: GatewaySession,
    kind: number,
    payload: Uint8Array
  ): ControlSendStatus => {
    try {
      const ws = gateway.wsServer as {
        sendControl?: (s: GatewaySession, k: number, p: Uint8Array) => ControlSendStatus;
        sendEnvelope?: (s: GatewaySession, k: number, p: Uint8Array) => void;
      };
      if (typeof ws.sendControl === 'function') {
        return ws.sendControl(session, kind, payload);
      }
      ws.sendEnvelope?.(session, kind, payload);
      return 'sent';
    } catch {
      return 'closed';
    }
  };

  const rtc = new RtcPeerManager({
    loadNative,
    iceConfigProvider: () => lastRtc ?? { stun: config.stunServers, turn: turnConfig(config) },
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore,
    handshakeTimeoutMs: opts.rtcHandshakeTimeoutMs,
    sendControl,
    deliverInbound: (session, bytes) => {
      const entry = sessions.getBySession(session);
      if (!entry || !verifyBoundSession(entry)) return;
      try {
        gateway.wsServer.handleMessage(session, Buffer.from(bytes));
      } catch {
        // fake / partial wsServer in tests
      }
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
    const verified = nodeSessionStore.verify(entry.sid, {
      viaNodeId: entry.via,
      now,
    });
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
    } catch {
      // already closed
    }
    bulk.abortByOwner(entry.connectionId);
    if (!entry.session.closed && typeof wsServer.closeSession === 'function') {
      try {
        wsServer.closeSession(entry.session, WS_CLOSE_LOGIN_REQUIRED, 'NODE_LOGIN_REQUIRED');
      } catch {
        // already closed
      }
    }
  }

  const statusProvider = () => ({
    version: getDisplayVersion(),
    tmux: true,
    direct_capable: rtc.available,
    inventory: {},
    endpoints: enumeratePeerEndpoints(
      peerHolder.manager?.listenPort ?? config.peerPort,
      interfacesFn()
    ),
  });

  const httpHolder: { runtime: MeshHttpRuntime | null } = { runtime: null };

  const uplink = new UplinkClient({
    hubUrl: hubEndpointUrl(config),
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userId,
    keyLogApplier: applier,
    userStore,
    statusProvider,
    wsFactory: opts.wsFactory,
    scheduler: opts.scheduler,
    pingIntervalMs: opts.pingIntervalMs,
    onEnrollRedeemed: (msg) => {
      httpHolder.runtime?.mesh.forwardEnrollRedeemed({
        enrollPk: msg.enroll_pk,
        certificate: msg.certificate,
        certSig: msg.cert_sig,
        nodeId: msg.nodeId,
        entrySid: msg.entrySid,
      });
    },
    onNodeList: (list) => {
      lastNodeList = list;
      lastRtc = {
        stun: list.rtc.stun,
        turn: list.rtc.turn ?? null,
      };
      for (const node of list.nodes) {
        if (node.id === HUB_META_PEER_ID) continue;
        const cert = userStore.getCert(node.id);
        if (!cert || (userId && cert.userId !== userId) || cert.revokedLogSeq != null) {
          userStore.deletePeer(node.id);
          if (cert?.revokedLogSeq != null) {
            peerHolder.manager?.onRevoked(node.id);
            emitNodeEvent({ nodeId: node.id, status: 'revoked' });
          }
          continue;
        }
        emitNodeEvent({
          nodeId: node.id,
          status: node.online ? 'online' : 'offline',
          inventory:
            typeof node.inventory === 'string'
              ? node.inventory
              : JSON.stringify(node.inventory ?? null),
        });
      }
      for (const peer of userStore.listPeers()) {
        if (peer.nodeId === identity.nodeIdHex || peer.nodeId === HUB_META_PEER_ID) continue;
        const cert = userStore.getCert(peer.nodeId);
        if (!cert || (userId && cert.userId !== userId) || cert.revokedLogSeq != null) {
          if (cert?.revokedLogSeq != null) {
            peerHolder.manager?.onRevoked(peer.nodeId);
          } else {
            userStore.deletePeer(peer.nodeId);
          }
        }
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
      if (dcPeer) {
        peerHolder.manager?.receiveRtcSignal(dcPeer, signal);
      }
      if (signal.from === 'browser') {
        innerSignalsHolder.router?.deliverLocal(signal);
        startBrowserAcceptHolder.fn(signal.rtcSession);
      }
      for (const cb of signalListeners) {
        try {
          cb(signal);
        } catch {
          // ignore
        }
      }
    },
  });

  const noopUpgrade: MeshUpgradeServer = { upgrade: () => false };

  const dispatchInboundHttp = async (request: Request, ctx: DispatchContext): Promise<Response> => {
    const trusted = requestDispatchContext.get(request);
    const via = trusted?.viaNodeId ?? ctx.viaNodeId;
    const uid = trusted?.uid ?? ctx.uid;
    const renewedExpiresAt = trusted?.renewedExpiresAt ?? ctx.renewedExpiresAt;
    setMeshRequestContext(request, {
      via,
      uid,
      clientIp: `peer:${via}`,
      ...(renewedExpiresAt !== undefined ? { renewedExpiresAt } : {}),
    });
    requestDispatchContext.set(request, {
      uid,
      viaNodeId: via,
      ...(renewedExpiresAt !== undefined ? { renewedExpiresAt } : {}),
    });
    const meshHttp = httpHolder.runtime;
    if (meshHttp) {
      const meshRes = await meshHttp.handleRequest(request, noopUpgrade);
      if (meshRes instanceof Response) return meshRes;
    }
    if (config.roles.hub && hub) {
      const hubRes = await hub.handleRequest(request, noopUpgrade);
      if (hubRes instanceof Response) return hubRes;
    }
    return gateway.dispatchHttp(request, {
      uid,
      viaNodeId: via,
      ...(renewedExpiresAt !== undefined ? { renewedExpiresAt } : {}),
    });
  };

  const peerManager = new PeerManager({
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore,
    uplink,
    peerPort: config.peerPort,
    keyLogApplier: applier,
    statusProvider,
    sessionStore: nodeSessionStore,
    dispatchHttp: dispatchInboundHttp,
    wsServer: gateway.wsServer,
    hostname: resolvePeerBindHost(opts.peerHostname, config.peerBindHost),
    startServer: opts.startPeerServer,
    scheduler: opts.scheduler,
    rtc,
    linkFactory: opts.linkFactory,
    onGatewaySession: (session, auth) => sessions.register({ ...auth, session }).ok,
    onGatewaySessionClose: (session) => {
      const entry = sessions.getBySession(session);
      if (entry) teardownBinding(entry);
      else sessions.unregisterSession(session);
    },
    onBrowserSignal: (signal, fromNodeId) => {
      innerSignalsHolder.router?.deliverLocal(signal, fromNodeId);
      startBrowserAcceptHolder.fn(signal.rtcSession);
    },
    ensureDcSession: (peerNodeId, rtcSession) => {
      if (!rtcSession.startsWith('dc:')) return;
      hub?.uplink.ensureDcSession(userId, identity.nodeIdHex, peerNodeId);
    },
  });
  peerHolder.manager = peerManager;

  const peers: PeerLinkProvider = {
    getLink: (nodeId) => peerManager.getLink(nodeId),
    listReach: () => {
      const reach = peerManager.listReach();
      const list = lastNodeList;
      if (!list || uplink.state !== 'online') return reach;
      for (const node of list.nodes) {
        if (node.id === identity.nodeIdHex || !node.online) continue;
        const cert = userStore.getCert(node.id);
        if (!cert || (userId && cert.userId !== userId) || cert.revokedLogSeq != null) continue;
        if (reach.get(node.id) == null) {
          reach.set(node.id, 'relay');
        }
      }
      return reach;
    },
    onNodeEvent: (cb) => {
      nodeEvents.add(cb);
      return () => {
        nodeEvents.delete(cb);
      };
    },
  };

  const streams: StreamOpener = {
    openHttpStream: (link, open, body, signal) =>
      openHttpStream(
        link,
        {
          type: 'http',
          method: open.method,
          path: open.path,
          query: open.query,
          headers: open.headers,
          origin: open.origin,
          auth: open.auth,
        },
        body,
        signal
      ),
    openWsStream: (link, auth, cid) => openAdaptedWsStream(link, auth, cid),
  };

  const publisher: KeyLogPublisher = {
    publish(record) {
      try {
        uplink.sendCtl({ t: 'key.log.append', bytes: record.bytes, sig: record.sig });
      } catch {
        // uplink offline
      }
    },
    async publishAndAck(record) {
      const ack = await uplink.appendAndAck(record);
      if (ack.ok) return { ok: true, seq: ack.seq ?? 0n };
      return { ok: false, error: ack.error ?? 'hub_error' };
    },
    queryHubHead: () => uplink.queryHubHead(),
    queryKeyLogAt: (seq) => uplink.queryKeyLogAt(seq),
  };

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
      if (msg.rtcSession.startsWith('dc:')) {
        hub?.uplink.ensureDcSession(userId, identity.nodeIdHex, nodeId);
      }
      const live = peerManager.getLive(nodeId);
      if (live) {
        live.ctl.send(
          encodeJsonBytes({
            t: 'rtc.signal',
            rtcSession: msg.rtcSession,
            from: msg.from,
            to: msg.to,
            ...(msg.sdp ? { sdp: msg.sdp } : {}),
            ...(msg.candidate ? { candidate: msg.candidate } : {}),
          })
        );
        return;
      }
      try {
        uplink.sendCtl({
          t: 'rtc.signal',
          rtcSession: msg.rtcSession,
          from: msg.from,
          to: msg.to,
          ...(msg.sdp ? { sdp: msg.sdp } : {}),
          ...(msg.candidate ? { candidate: msg.candidate } : {}),
        });
      } catch {
        // uplink offline
      }
    },
  });
  innerSignalsHolder.router = innerSignals;

  const startBrowserAccept = (rtcSession: string) => {
    if (!rtcSession || acceptingBrowser.has(rtcSession)) return;
    const auth = rtc.authorizationOf(rtcSession);
    if (!auth) return;
    acceptingBrowser.add(rtcSession);
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
          verifyBoundSession(binding)
        ) {
          binding.pc = result.pc;
          rtc.attachDirect(binding.session, result.carrier, { rtcSession: result.rtcSession });
          result.pc.onDataChannel((dc) => {
            if (parseBulkChannelLabel(dc.getLabel?.())) {
              bulk.attachChannel(dc, {
                uid: result.uid,
                ownerKey: binding.connectionId,
                verify: () => verifyBoundSession(binding),
              });
            }
          });
        } else {
          try {
            result.carrier.close(1000, 'session-mismatch');
          } catch {
            // ignore
          }
          try {
            result.pc.close();
          } catch {
            // ignore
          }
        }
      })
      .catch(() => {
        // handshake failed
      })
      .finally(() => {
        acceptingBrowser.delete(rtcSession);
        innerSignals.unregister(rtcSession);
      });
  };
  startBrowserAcceptHolder.fn = startBrowserAccept;

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
      signalListeners.add(cb);
      return () => {
        offRouter();
        signalListeners.delete(cb);
      };
    },
  };

  const http = new MeshHttpRuntime({
    roles: config.roles,
    nodeId: identity.nodeIdHex,
    nodePk: identity.edPublicKey,
    userStore,
    keyLogService,
    challengeStore,
    nodeSessionStore,
    peers,
    streams,
    publisher,
    rtc: {
      fingerprint,
      signals,
      config: {
        getRtcConfig: () => lastRtc,
      },
    },
    primaryUserId: userId || undefined,
    hubPublicUrl: hubEndpointUrl(config),
    trustProxy: gatewayConfig.trustProxy,
    connectionLookup: (input) =>
      sessions.lookup(input.sid, input.via, input.connectionId, input.cid),
  });
  httpHolder.runtime = http;

  const uplinkHub = hub ?? opts.uplinkHub ?? null;
  let stopPromise: Promise<void> | null = null;

  const runtime: MeshRuntime = {
    nodeId: identity.nodeIdHex,
    identity,
    hub,
    uplink,
    peers: peerManager,
    rtc,
    sessions,
    userStore,
    userKeyService: keyLogService,
    registerGatewaySession(entry) {
      return sessions.register(entry);
    },
    unregisterGatewaySession(sidOrSession) {
      if (typeof sidOrSession === 'string') sessions.unregister(sidOrSession);
      else sessions.unregisterSession(sidOrSession);
    },
    get lastNodeList() {
      return lastNodeList;
    },
    set lastNodeList(value) {
      lastNodeList = value;
    },
    handleRequest: (req, server) => http.handleRequest(req, server),
    localUiGuard: (req) => http.localUiGuard(req),
    guardGatewayWebSocket: (req, server) => http.guardGatewayWebSocket(req, server),
    rewriteSelf: (req) => http.rewriteSelf(req),
    closeSocketsForUser: (uid) => {
      http.closeSocketsForUser(uid);
      for (const entry of sessions.listByUid(uid)) teardownBinding(entry);
    },
    closeSocketsForSid: (sid) => {
      http.closeSocketsForSid(sid);
      for (const entry of sessions.listBySid(sid)) teardownBinding(entry);
    },
    touchSocket: (ws) => http.touchSocket(ws),
    websocket: {
      open: (ws) => http.handleWebSocket.open(ws),
      message: (ws, message) => http.handleWebSocket.message(ws, message),
      drain() {},
      close: (ws, code, reason) => http.handleWebSocket.close(ws, code, reason),
    },
    async start() {
      await rtc.ready();
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
        try {
          await peerManager.stop();
        } catch (err) {
          console.error('[tmex] peer stop failed', err);
        }
        try {
          await uplink.stop();
        } catch (err) {
          console.error('[tmex] uplink stop failed', err);
        }
        try {
          http.stop();
        } catch (err) {
          console.error('[tmex] mesh http stop failed', err);
        }
        try {
          rtc.close();
        } catch (err) {
          console.error('[tmex] rtc stop failed', err);
        }
        try {
          bulk.close();
        } catch (err) {
          console.error('[tmex] bulk stop failed', err);
        }
      })();
      return stopPromise;
    },
  };
  return runtime;
}
