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
import type { TmexRoles } from '../config';
import { HubRuntime, type HubTurnConfig } from '../hub';
import { createHubKeyLogSource } from '../hub/hub-key-log-source';
import type { GatewayRuntime } from '../runtime';
import { getDisplayVersion } from '../system/version';
import { backoffDelayMs } from './ctl';
import {
  type CachedRtcConfig,
  type KeyLogPublisher,
  MESH_VIA_SELF,
  type MeshServerWebSocket,
  type MeshUpgradeServer,
  type NodeEventPayload,
  type OpenedWsStream,
  type PeerLinkProvider,
  type RtcSignalMessage,
  type RtcSignalRouter,
  type StreamOpener,
  getMeshRequestContext,
} from './mesh-deps';
import { MeshHttpRuntime } from './mesh-http';
import { PeerManager } from './peer-manager';
import { authenticateRequest } from './session-middleware';
import { openHttpStream, openWsStream } from './stream-targets';
import type { KeyLogApplier, MeshScheduler, UplinkState } from './types';
import {
  UPLINK_BACKOFF_MAX_MS,
  UPLINK_BACKOFF_MIN_MS,
  UplinkClient,
  type UplinkWsFactory,
} from './uplink-client';
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
  wsFactory?: UplinkWsFactory;
  peerHostname?: string | string[];
  startPeerServer?: boolean;
  pingIntervalMs?: number;
  scheduler?: MeshScheduler;
  userId?: string;
};

export type MeshRuntime = {
  readonly nodeId: string;
  readonly identity: NodeIdentityKeys;
  readonly hub: HubRuntime | null;
  readonly uplink: UplinkClient;
  readonly peers: PeerManager;
  readonly userStore: UserStore;
  readonly userKeyService: UserKeyService;
  lastNodeList: UplinkNodeList | null;
  handleRequest(req: Request, server: MeshUpgradeServer): Promise<Response | null | undefined>;
  localUiGuard(req: Request): Response | null;
  websocket: {
    open: (ws: MeshServerWebSocket) => void;
    message: (ws: MeshServerWebSocket, message: string | Buffer) => void;
    drain: (ws: MeshServerWebSocket) => void;
    close: (ws: MeshServerWebSocket, code: number, reason: string) => void;
  };
  start(): Promise<void>;
  stop(): Promise<void>;
};

type UplinkInternals = {
  bindLink(link: LinkSession, generation: number): void;
  authenticate(link: LinkSession, signal: AbortSignal): Promise<void>;
  setState(state: UplinkState): void;
  startHeartbeat(link: LinkSession, generation: number): void;
  tearDownLink(reason: string): void;
  waitUntilClosed(signal: AbortSignal): Promise<void>;
  connectGeneration: number;
  stopAbort: AbortController | null;
  loop: Promise<void> | null;
  scheduler: MeshScheduler;
};

function uplinkInternals(uplink: UplinkClient): UplinkInternals {
  return uplink as unknown as UplinkInternals;
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

function startInMemoryUplink(uplink: UplinkClient, hub: HubRuntime): void {
  const internals = uplinkInternals(uplink);
  if (internals.loop) return;
  internals.stopAbort = new AbortController();
  const signal = internals.stopAbort.signal;
  internals.loop = (async () => {
    let attempt = 0;
    while (!signal.aborted) {
      internals.setState('connecting');
      const [nodeLink, hubLink] = createInMemoryLinkPair();
      const generation = ++internals.connectGeneration;
      uplink.link = nodeLink;
      internals.bindLink(nodeLink, generation);
      const authed = internals.authenticate(nodeLink, signal);
      hub.attachLocalNode(hubLink);
      try {
        await authed;
        if (signal.aborted || generation !== internals.connectGeneration) {
          throw new Error('aborted');
        }
        internals.setState('online');
        uplink.sendStatus();
        internals.startHeartbeat(nodeLink, generation);
        attempt = 0;
        await internals.waitUntilClosed(signal);
      } catch {
        internals.tearDownLink('connect-failed');
        internals.setState('offline');
        if (signal.aborted) return;
        const delay = backoffDelayMs(attempt, UPLINK_BACKOFF_MIN_MS, UPLINK_BACKOFF_MAX_MS);
        attempt += 1;
        try {
          await internals.scheduler.sleep(delay, signal);
        } catch {
          return;
        }
      }
    }
  })();
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
          publicUrl: config.hubPublicUrl ?? config.hubUrl ?? 'http://127.0.0.1',
          stun: config.stunServers,
          turn: (turnConfig(config) as HubTurnConfig) ?? null,
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
          };
        },
      }))
    : (opts.hub ?? null);

  const peerHolder: { manager: PeerManager | null } = { manager: null };
  const statusProvider = () => ({
    version: getDisplayVersion(),
    tmux: true,
    direct_capable: false,
    inventory: {},
    endpoints: peerHolder.manager?.listenPort
      ? [`ws://127.0.0.1:${peerHolder.manager.listenPort}/peer`]
      : [],
  });

  const uplink = new UplinkClient({
    hubUrl: config.hubUrl ?? 'http://127.0.0.1',
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userId,
    keyLogApplier: applier,
    userStore,
    statusProvider,
    wsFactory: opts.wsFactory,
    scheduler: opts.scheduler,
    pingIntervalMs: opts.pingIntervalMs,
    onNodeList: (list) => {
      lastNodeList = list;
      lastRtc = {
        stun: list.rtc.stun,
        turn: list.rtc.turn ?? null,
      };
      for (const node of list.nodes) {
        emitNodeEvent({
          nodeId: node.id,
          status: node.online ? 'online' : 'offline',
          inventory:
            typeof node.inventory === 'string'
              ? node.inventory
              : JSON.stringify(node.inventory ?? null),
        });
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
      for (const cb of signalListeners) {
        try {
          cb(signal);
        } catch {
          // ignore
        }
      }
    },
  });

  const peerManager = new PeerManager({
    identity: { nodeId: identity.nodeIdHex, edSecretKey: identity.edPrivateKey },
    userStore,
    uplink,
    peerPort: config.peerPort,
    keyLogApplier: applier,
    statusProvider,
    sessionStore: nodeSessionStore,
    dispatchHttp: (request, ctx) => gateway.dispatchHttp(request, ctx),
    wsServer: gateway.wsServer,
    hostname: opts.peerHostname,
    startServer: opts.startPeerServer,
    scheduler: opts.scheduler,
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
  };

  const signals: RtcSignalRouter = {
    send(signal) {
      try {
        uplink.sendCtl({
          t: 'rtc.signal',
          rtcSession: signal.rtcSession,
          from: signal.from,
          to: signal.to,
          ...(signal.sdp ? { sdp: signal.sdp } : {}),
          ...(signal.candidate ? { candidate: signal.candidate } : {}),
        });
      } catch {
        // uplink offline
      }
    },
    subscribe(cb) {
      signalListeners.add(cb);
      return () => {
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
      signals,
      config: {
        getRtcConfig: () => lastRtc,
      },
    },
    primaryUserId: userId || undefined,
  });

  const runtime: MeshRuntime = {
    nodeId: identity.nodeIdHex,
    identity,
    hub,
    uplink,
    peers: peerManager,
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
    websocket: {
      open: (ws) => http.handleWebSocket.open(ws),
      message: (ws, message) => http.handleWebSocket.message(ws, message),
      drain() {},
      close: (ws, code, reason) => http.handleWebSocket.close(ws, code, reason),
    },
    async start() {
      await peerManager.start();
      if (hub) {
        startInMemoryUplink(uplink, hub);
      } else {
        uplink.start();
      }
    },
    async stop() {
      await peerManager.stop();
      await uplink.stop();
      http.stop();
    },
  };
  return runtime;
}
