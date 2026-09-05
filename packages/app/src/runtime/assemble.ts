import { resolve } from 'node:path';
import { setSiteSettingsLinkProvider } from '../../../../apps/gateway/src/api/site-settings-link';
import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { ChallengeStore } from '../../../../apps/gateway/src/auth/challenge-store';
import { MeshHubStore } from '../../../../apps/gateway/src/auth/mesh-hub-store';
import { ensureNodeIdentity } from '../../../../apps/gateway/src/auth/node-identity-service';
import { NodeIdentityStore } from '../../../../apps/gateway/src/auth/node-identity-store';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
import { runtimeController } from '../../../../apps/gateway/src/control/runtime';
import { getStoredSiteSettings, updateSiteSettings } from '../../../../apps/gateway/src/db';
import {
  LocalAuthStore,
  readLocalAuthEffective,
} from '../../../../apps/gateway/src/db/local-auth-settings';
import type { HubRuntime } from '../../../../apps/gateway/src/hub';
import { createMeshSiteSettingsLink } from '../../../../apps/gateway/src/mesh/effective-site-url';
import { MeshHttpRuntime } from '../../../../apps/gateway/src/mesh/mesh-http';
import {
  type CreateMeshRuntimeOptions,
  type MeshRuntime,
  createMeshRuntime,
} from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { LoadNative } from '../../../../apps/gateway/src/mesh/rtc';
import type { RelayRuntime } from '../../../../apps/gateway/src/relay';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { broadcastSettingsUpdate } from '../../../../apps/gateway/src/settings/broadcaster';
import { getShareService } from '../../../../apps/gateway/src/share';
import { resolveInstallDir as resolveGatewayInstallDir } from '../../../../apps/gateway/src/system/install-info';
import { getBaseVersion } from '../../../../apps/gateway/src/system/version';
import { readEnvFile, writeEnvFile } from '../lib/env-file';
import { withEnvLock } from '../lib/env-mutation';
import { type LocalAuthContext, createAuthContextFromDb } from '../lib/local-auth';
import { loadNodeDatachannel } from '../lib/native-datachannel';
import { type TmexRoles, isStandaloneRoles, parseTmexRoles } from '../lib/roles';
import { HttpsListener } from '../tls/https-listener';
import type { TlsService } from '../tls/tls-service';
import { createAssembledRelay } from './assemble-relay';
import {
  advertisedTlsInfo,
  buildHttpAndWs,
  buildLocalRouteDeps,
  createAssembledLifecycle,
  tryStop,
  wireTlsLifecycle,
} from './assemble-routes';
import { createTmexGatewayRuntime } from './gateway';
import { type RuntimeMode, handlePreflightHttp, readRuntimeMode } from './mode';
import { serveFrontend as defaultServeFrontend } from './serve-frontend';
import { SETUP_RESTART_DELAY_MS, resolveSetupEnvPath } from './setup-service';

export const SHUTDOWN_TIMEOUT_MS = 20_000;

export function meshShutdownNeeded(roles: TmexRoles): boolean {
  return roles.hub || roles.node || roles.relay;
}

type AssembleTmexOptions = {
  roles?: TmexRoles;
  staticRoot?: string;
  runtimeMode?: RuntimeMode;
  createGatewayRuntime?: () => Promise<GatewayRuntime>;
  createMeshRuntime?: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  serveFrontend?: (req: Request, staticRoot: string) => Promise<Response>;
  hub?: HubRuntime;
  loadNative?: LoadNative;
  nativeDir?: string;
  localAuthEffective?: () => boolean;
};

type AssembledTmex = {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  mesh: MeshRuntime | null;
  hub: HubRuntime | null;
  relay: RelayRuntime | null;
  tls: TlsService;
  httpsListener: HttpsListener;
  fetch: (
    req: Request,
    bunServer: Bun.Server<unknown>
  ) => Response | Promise<Response | undefined> | undefined;
  websocket: GatewayRuntime['websocket'];
  start: () => Promise<void>;
  stop: () => Promise<void>;
  setProcessShutdown: (run: () => Promise<void>) => void;
  isRestartRequested: () => boolean;
};

function defaultStaticRoot(): string {
  return process.env.TMEX_FE_DIST_DIR
    ? resolve(process.env.TMEX_FE_DIST_DIR)
    : resolve(import.meta.dir, '../../resources/fe-dist');
}

async function standaloneNodeKeys(identityStore: LocalAuthContext['identityStore']) {
  try {
    return await ensureNodeIdentity(identityStore);
  } catch {
    return { nodeIdHex: '00'.repeat(16), edPublicKey: new Uint8Array(32) };
  }
}

async function createStandaloneAuthHttp(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  auth: LocalAuthContext;
  localAuthEffective?: () => boolean;
  tlsSlot: { service?: TlsService };
}): Promise<MeshHttpRuntime> {
  const keys = await standaloneNodeKeys(input.auth.identityStore);
  const runtime = new MeshHttpRuntime({
    roles: input.roles,
    nodeId: keys.nodeIdHex,
    nodePk: keys.edPublicKey,
    userStore: input.auth.userStore,
    keyLogService: input.auth.userKeys,
    challengeStore: new ChallengeStore(),
    nodeSessionStore: input.auth.nodeSessionStore,
    publisher: { publish() {} },
    authSurfaceOnly: true,
    trustProxy: gatewayConfig.trustProxy,
    localAuth: new LocalAuthStore(input.gateway.db),
    localAuthEffective: input.localAuthEffective,
  });
  runtime.auth.setTlsInfo(() => advertisedTlsInfo(input.tlsSlot.service));
  return runtime;
}

type MeshHubAssembleOpts = CreateMeshRuntimeOptions & {
  meshHubStore?: MeshHubStore;
  meshHubs?: MeshHubStore;
  config: CreateMeshRuntimeOptions['config'] & {
    hubMode?: string;
    hubPriority?: number;
    hubWriterEpoch?: number;
    hubNodeId?: string;
  };
};

function syncLocalSiteNameFromMesh(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const current = getStoredSiteSettings();
  if (current.siteName === trimmed) return;
  updateSiteSettings({ siteName: trimmed });
  broadcastSettingsUpdate('site');
}

async function createNodeMesh(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  hub?: HubRuntime;
  loadNative?: LoadNative;
  nativeDir?: string;
  tlsSlot: { service?: TlsService };
  meshHubStore?: MeshHubStore;
  onLocalNodeName?: (name: string) => void;
}): Promise<MeshRuntime> {
  const nativeDir = input.nativeDir ?? process.env.TMEX_NATIVE_DIR ?? '';
  const identity = await new NodeIdentityStore(input.gateway.db).load();
  const opts: MeshHubAssembleOpts = {
    db: input.gateway.db,
    gateway: input.gateway,
    config: {
      roles: input.roles,
      hubUrl: gatewayConfig.hubUrl,
      hubPublicUrl: gatewayConfig.hubPublicUrl,
      hubUrls: gatewayConfig.hubUrls,
      hubMode: gatewayConfig.hubMode,
      hubPriority: gatewayConfig.hubPriority,
      hubWriterEpoch: gatewayConfig.hubWriterEpoch,
      hubPeers: gatewayConfig.hubPeers,
      hubNodeId: identity?.nodeId,
      peerPort: gatewayConfig.peerPort,
      stunServers: gatewayConfig.stunServers,
      turnUrl: gatewayConfig.turnUrl,
      turnUsername: gatewayConfig.turnUsername,
      turnCredential: gatewayConfig.turnCredential,
      bindHost: process.env.TMEX_BIND_HOST || '127.0.0.1',
      peerBindHost: gatewayConfig.peerBindHost,
    },
    hub: input.hub,
    meshHubStore: input.meshHubStore,
    meshHubs: input.meshHubStore,
    canLoadNative: () =>
      process.env.TMEX_DIRECT_ENABLED !== 'false' &&
      (input.loadNative !== undefined || nativeDir.length > 0),
    loadNative:
      input.loadNative ??
      (async () =>
        process.env.TMEX_DIRECT_ENABLED === 'false' || !nativeDir
          ? null
          : loadNodeDatachannel({ nativeDir })),
    userId: identity?.userId ?? undefined,
    tlsInfo: () => advertisedTlsInfo(input.tlsSlot.service),
    patchHubRoleEnv: async (patch) => {
      const envPath = resolveSetupEnvPath();
      await withEnvLock(async () => {
        let existing: Record<string, string> = {};
        try {
          existing = await readEnvFile(envPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await writeEnvFile(envPath, { ...existing, ...patch });
      });
    },
    scheduleHubRoleRestart: (delayMs) => {
      setTimeout(() => {
        void runtimeController.requestRestart();
      }, delayMs);
    },
    onLocalNodeName: input.onLocalNodeName,
  };
  return input.createMesh(opts);
}

function resolveLocalAuthEffective(
  injected: (() => boolean) | undefined,
  authHttp: MeshHttpRuntime | null
): () => boolean {
  if (injected) return injected;
  if (!authHttp) return readLocalAuthEffective;
  return safeAssembleLocalAuth(authHttp);
}

function safeAssembleLocalAuth(authHttp: MeshHttpRuntime): () => boolean {
  return () => {
    try {
      return authHttp.auth.isLocalAuthEffective();
    } catch {
      return false;
    }
  };
}

function dummyTlsLifecycle(): { tls: TlsService; httpsListener: HttpsListener } {
  const httpsListener = new HttpsListener({
    fetch: async () => new Response('Not Found', { status: 404 }),
    websocket: {
      open() {},
      message() {},
      drain() {},
      close() {},
    },
  });
  return {
    httpsListener,
    tls: {
      async startup() {},
      stop() {},
    } as TlsService,
  };
}

async function assemblePreflightTmex(opts: AssembleTmexOptions): Promise<AssembledTmex> {
  const roles = opts.roles ?? parseTmexRoles(process.env.TMEX_ROLES);
  const createGateway =
    opts.createGatewayRuntime ?? (() => createTmexGatewayRuntime(undefined, { mode: 'preflight' }));
  const gateway = await createGateway();
  const { tls, httpsListener } = dummyTlsLifecycle();
  return {
    roles,
    gateway,
    mesh: null,
    hub: opts.hub ?? null,
    relay: null,
    tls,
    httpsListener,
    fetch: (req) => handlePreflightHttp(req, getBaseVersion(), PROCESS_STARTED_AT),
    websocket: gateway.websocket,
    async start() {},
    async stop() {
      await tryStop(() => gateway.stop(), 'gateway');
    },
    setProcessShutdown() {},
    isRestartRequested() {
      return false;
    },
  };
}

async function createAssembleAuthSurface(input: {
  roles: TmexRoles;
  gateway: GatewayRuntime;
  opts: AssembleTmexOptions;
  createMesh: (opts: CreateMeshRuntimeOptions) => Promise<MeshRuntime>;
  tlsSlot: { service?: TlsService };
  meshHubStore?: MeshHubStore;
  onLocalNodeName?: (name: string) => void;
}) {
  const auth = await createAuthContextFromDb(input.gateway.db, {
    installDir: resolveGatewayInstallDir(),
    envPath: resolveSetupEnvPath(),
    env: {
      TMEX_ROLES: process.env.TMEX_ROLES ?? '',
      TMEX_HUB_URL: process.env.TMEX_HUB_URL ?? '',
      TMEX_HUB_PUBLIC_URL: process.env.TMEX_HUB_PUBLIC_URL ?? '',
    },
  });
  let mesh: MeshRuntime | null = null;
  let authHttp: MeshHttpRuntime | null = null;
  if (isRelayOnly(input.roles)) {
    // relay 单跑：没有用户、没有节点身份，不挂 auth surface
  } else if (input.roles.node) {
    mesh = await createNodeMesh({
      roles: input.roles,
      gateway: input.gateway,
      createMesh: input.createMesh,
      hub: input.opts.hub,
      loadNative: input.opts.loadNative,
      nativeDir: input.opts.nativeDir,
      tlsSlot: input.tlsSlot,
      meshHubStore: input.meshHubStore,
      onLocalNodeName: input.onLocalNodeName,
    });
  } else {
    authHttp = await createStandaloneAuthHttp({
      roles: input.roles,
      gateway: input.gateway,
      auth,
      localAuthEffective: input.opts.localAuthEffective,
      tlsSlot: input.tlsSlot,
    });
  }
  return { auth, mesh, authHttp, hub: mesh?.hub ?? input.opts.hub ?? null };
}

/** `relay` 单跑（不带 node）：无前端、无用户存储、无 tmux 依赖。 */
export function isRelayOnly(roles: TmexRoles): boolean {
  return roles.relay && !roles.node && !roles.hub;
}

async function relayOnlyFrontend(): Promise<Response> {
  return new Response(JSON.stringify({ error: { code: 'RELAY_NO_FRONTEND' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

function maybeMeshHubStore(roles: TmexRoles, db: GatewayRuntime['db']): MeshHubStore | undefined {
  return roles.hub || roles.node ? new MeshHubStore(db) : undefined;
}

function applySiteSettingsLink(
  roles: TmexRoles,
  mesh: MeshRuntime | null,
  meshHubStore: MeshHubStore | undefined
): void {
  if (roles.hub || roles.node) {
    setSiteSettingsLinkProvider(
      createMeshSiteSettingsLink({
        roles,
        localNodeId: () => mesh?.nodeId ?? null,
        hubStore: meshHubStore ?? null,
        attachedHub: () => mesh?.attachedHub() ?? null,
        hubPublicUrl: gatewayConfig.hubPublicUrl,
        hubMetaPublicUrl: () => mesh?.userStore.getHubMeta()?.publicUrl ?? null,
      })
    );
  } else {
    setSiteSettingsLinkProvider(null);
  }
}

function subscribeReplicatedNodeList(
  mesh: MeshRuntime | null,
  hub: HubRuntime | null
): (() => void) | undefined {
  if (
    mesh &&
    hub &&
    typeof mesh.onNodeList === 'function' &&
    typeof hub.applyReplicatedNodeList === 'function'
  ) {
    return mesh.onNodeList((list, meta) => {
      hub.applyReplicatedNodeList(list, meta);
    });
  }
}

export async function assembleTmex(opts: AssembleTmexOptions = {}): Promise<AssembledTmex> {
  const runtimeMode = opts.runtimeMode ?? readRuntimeMode();
  if (runtimeMode === 'preflight') return assemblePreflightTmex(opts);
  const roles = opts.roles ?? parseTmexRoles(process.env.TMEX_ROLES);
  const staticRoot = opts.staticRoot ?? defaultStaticRoot();
  const createGateway =
    opts.createGatewayRuntime ?? (() => createTmexGatewayRuntime(undefined, { mode: runtimeMode }));
  const createMesh = opts.createMeshRuntime ?? createMeshRuntime;
  const serveFrontend =
    opts.serveFrontend ?? (isRelayOnly(roles) ? relayOnlyFrontend : defaultServeFrontend);
  const gateway = await createGateway();
  const tlsSlot: { service?: TlsService } = {};
  const meshHubStore = maybeMeshHubStore(roles, gateway.db);
  const { auth, mesh, authHttp, hub } = await createAssembleAuthSurface({
    roles,
    gateway,
    opts,
    createMesh,
    tlsSlot,
    meshHubStore,
    onLocalNodeName: syncLocalSiteNameFromMesh,
  });
  applySiteSettingsLink(roles, mesh, meshHubStore);
  const localAuthEffective = resolveLocalAuthEffective(opts.localAuthEffective, authHttp);
  // 免登录（standalone 未开启本机登录）部署无法兑现分享隔离：直接禁止创建对外分享。
  getShareService().setAuthRequiredResolver(
    () => !isStandaloneRoles(roles) || localAuthEffective()
  );
  if (roles.hub) {
    console.log(
      `[hub] mode=${gatewayConfig.hubMode} priority=${gatewayConfig.hubPriority} writerEpoch=${gatewayConfig.hubWriterEpoch} publicUrl=${gatewayConfig.hubPublicUrl ?? ''}`
    );
  }
  const unsubscribeNodeList = subscribeReplicatedNodeList(mesh, hub);
  const shutdown = {
    processShutdown: null as (() => Promise<void>) | null,
    restartRequested: false,
  };
  const scheduleRestart = (): void => {
    shutdown.restartRequested = true;
    setTimeout(
      () => void (shutdown.processShutdown ? shutdown.processShutdown() : process.exit(0)),
      SETUP_RESTART_DELAY_MS
    );
  };
  const routeDeps = buildLocalRouteDeps({
    roles,
    auth,
    mesh,
    hub,
    tlsSlot,
    scheduleRestart,
    localAuthEffective,
  });
  const relay = await createAssembledRelay({ roles, gateway, routeDeps });
  const http = buildHttpAndWs({
    gateway,
    mesh,
    hub,
    relay,
    authHttp,
    routeDeps,
    serveFrontend,
    staticRoot,
  });
  const tlsLife = wireTlsLifecycle({
    http,
    gateway,
    routeDeps,
    tlsSlot,
    authHttp,
    mesh,
    hub,
  });
  return {
    roles,
    gateway,
    mesh,
    hub,
    relay,
    tls: tlsLife.tls,
    httpsListener: tlsLife.httpsListener,
    fetch: http.fetch,
    websocket: http.websocket,
    ...createAssembledLifecycle({
      mesh,
      gateway,
      authHttp,
      hub,
      relay,
      unsubscribeNodeList,
      shutdown,
    }),
  };
}

type ShutdownHooks = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  exit?: (code: number) => void;
  timeoutMs?: number;
};

export function createProcessShutdown(
  stop: () => Promise<void>,
  hooks: ShutdownHooks = {}
): () => Promise<void> {
  const exit = hooks.exit ?? ((code) => process.exit(code));
  const timeoutMs = hooks.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let promise: Promise<void> | null = null;
  return () => {
    if (promise) return promise;
    promise = new Promise<void>((resolve) => {
      let finished = false;
      const timer = setTimeout(() => done(1), timeoutMs);
      function done(code: number) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        exit(code);
        resolve();
      }
      void Promise.resolve()
        .then(stop)
        .then(
          () => done(0),
          () => done(1)
        );
    });
    return promise;
  };
}

export function installShutdownHandlers(
  stop: () => Promise<void>,
  hooks: ShutdownHooks = {}
): () => Promise<void> {
  const on =
    hooks.on ??
    ((event, listener) => {
      process.on(event as NodeJS.Signals, listener as NodeJS.SignalsListener);
    });
  const run = createProcessShutdown(stop, hooks);
  const handler = () => void run();
  on('SIGINT', handler);
  on('SIGTERM', handler);
  return run;
}
