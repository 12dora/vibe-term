import os from 'node:os';
import { type LinkSession, createInMemoryLinkPair } from '@tmex/shared/link';
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
import { type TmexRoles, config as gatewayConfig } from '../config';
import { HubRuntime, type HubTurnConfig } from '../hub';
import { createHubKeyLogSource } from '../hub/hub-key-log-source';
import type { GatewayRuntime } from '../runtime';
import { getDisplayVersion } from '../system/version';
import { encodeJsonBytes } from './ctl';
import {
  type CachedRtcConfig,
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
  getMeshRequestContext,
  requestDispatchContext,
  setMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { type PeerLinkFactory, PeerManager } from './peer-manager';
import { type LoadNative, MeshRtcSignalRouter, RtcPeerManager } from './rtc';
import { authenticateRequest } from './session-middleware';
import { openHttpStream, openWsStream } from './stream-targets';
import type { DispatchContext, KeyLogApplier, MeshScheduler } from './types';
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
};

export type CreateMeshRuntimeOptions = {
  db: AuthDb;
  gateway: GatewayRuntime;
  config: MeshRuntimeConfig;
  hub?: HubRuntime;
  /** Same-process hub to attach an in-memory uplink to (remote node in hub+A+B tests). */
  uplinkHub?: HubRuntime;
  wsFactory?: UplinkWsFactory;
  peerHostname?: string | string[];
  startPeerServer?: boolean;
  pingIntervalMs?: number;
  scheduler?: MeshScheduler;
  userId?: string;
  loadNative?: LoadNative;
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  linkFactory?: PeerLinkFactory;
  rtcHandshakeTimeoutMs?: number;
};

export type MeshRuntime = {
  readonly nodeId: string;
  readonly identity: NodeIdentityKeys;
  readonly hub: HubRuntime | null;
  readonly uplink: UplinkClient;
  readonly peers: PeerManager;
  readonly rtc: RtcPeerManager;
  readonly userStore: UserStore;
  readonly userKeyService: UserKeyService;
  lastNodeList: UplinkNodeList | null;
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

export function enumeratePeerEndpoints(
  port: number,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const family = addr.family as string | number;
      const isV4 = family === 'IPv4' || family === 4;
      const isV6 = family === 'IPv6' || family === 6;
      if (!isV4 && !isV6) continue;
      if (addr.address.includes('%')) continue;
      const host = isV6 ? `[${addr.address}]` : addr.address;
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

function resolvePeerBindHost(explicit?: string | string[]): string | string[] | undefined {
  if (explicit !== undefined) return explicit;
  const env = process.env.TMEX_PEER_BIND_HOST?.trim();
  return env ? env : undefined;
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

async function openAdaptedWsStream(link: LinkSession, auth: string): Promise<OpenedWsStream> {
  const opened = await openWsStream(link, auth);
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
  const interfacesFn = opts.networkInterfaces ?? os.networkInterfaces;
  const loadNative: LoadNative = opts.loadNative ?? (async () => null);

  const rtc = new RtcPeerManager({
    loadNative,
    iceConfigProvider: () => lastRtc ?? { stun: config.stunServers, turn: turnConfig(config) },
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore,
    handshakeTimeoutMs: opts.rtcHandshakeTimeoutMs,
    sendControl: (session, kind, payload) => {
      try {
        gateway.wsServer.sendEnvelope(session, kind, payload);
      } catch {
        // fake / partial wsServer in tests
      }
    },
    deliverInbound: (session, bytes) => {
      try {
        gateway.wsServer.handleMessage(session, Buffer.from(bytes));
      } catch {
        // fake / partial wsServer in tests
      }
    },
  });
  if (typeof gateway.wsServer.setOnCarrierSwitchAck === 'function') {
    gateway.wsServer.setOnCarrierSwitchAck((session, epoch) => {
      rtc.handleCarrierSwitchAck(session, epoch);
    });
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
        const cert = userStore.getCert(node.id);
        if (cert?.revokedLogSeq != null) {
          peerHolder.manager?.onRevoked(node.id);
          emitNodeEvent({ nodeId: node.id, status: 'revoked' });
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
        if (peer.nodeId === identity.nodeIdHex) continue;
        const cert = userStore.getCert(peer.nodeId);
        if (cert?.revokedLogSeq != null) {
          peerHolder.manager?.onRevoked(peer.nodeId);
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
    hostname: resolvePeerBindHost(opts.peerHostname),
    startServer: opts.startPeerServer,
    scheduler: opts.scheduler,
    rtc,
    linkFactory: opts.linkFactory,
  });
  peerHolder.manager = peerManager;

  const peers: PeerLinkProvider = {
    getLink: (nodeId) => peerManager.getLink(nodeId),
    listReach: () => peerManager.listReach(),
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
    openWsStream: (link, auth) => openAdaptedWsStream(link, auth),
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
    sendCtl(nodeId, msg) {
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
  const fingerprint: RtcFingerprintProvider = rtc;
  const signals = {
    send(signal: RtcSignalMessage, owner?: { uid: string; sid: string }) {
      if (owner && signal.from === 'browser' && !innerSignals.ownerOf(signal.rtcSession)) {
        innerSignals.register(signal.rtcSession, {
          browserSessionId: owner.sid,
          targetNodeId: signal.to,
        });
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
    userStore,
    userKeyService: keyLogService,
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
    closeSocketsForUser: (uid) => http.closeSocketsForUser(uid),
    closeSocketsForSid: (sid) => http.closeSocketsForSid(sid),
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
        await peerManager.stop();
        await uplink.stop();
        http.stop();
        rtc.close();
      })();
      return stopPromise;
    },
  };
  return runtime;
}
