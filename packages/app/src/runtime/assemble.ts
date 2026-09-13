import { resolve } from 'node:path';
import {
  setSiteAccessOriginsProvider,
  setSiteSettingsLinkProvider,
} from '../../../../apps/gateway/src/api/site-settings-link';
import { PROCESS_STARTED_AT } from '../../../../apps/gateway/src/api/system-routes';
import { MeshHubStore } from '../../../../apps/gateway/src/auth/mesh-hub-store';
import { MeshRelayStore } from '../../../../apps/gateway/src/auth/mesh-relay-store';
import { config as gatewayConfig } from '../../../../apps/gateway/src/config';
import { CryptoDecryptError } from '../../../../apps/gateway/src/crypto/errors';
import { getStoredSiteSettings } from '../../../../apps/gateway/src/db';
import type { HubRuntime } from '../../../../apps/gateway/src/hub';
import { createMeshSiteSettingsLink } from '../../../../apps/gateway/src/mesh/effective-site-url';
import type { MeshHttpRuntime } from '../../../../apps/gateway/src/mesh/mesh-http';
import {
  type CreateMeshRuntimeOptions,
  type MeshRuntime,
  createMeshRuntime,
} from '../../../../apps/gateway/src/mesh/mesh-runtime';
import type { LoadNative } from '../../../../apps/gateway/src/mesh/rtc';
import type { RelayRuntime } from '../../../../apps/gateway/src/relay';
import type { GatewayRuntime } from '../../../../apps/gateway/src/runtime';
import { getShareService } from '../../../../apps/gateway/src/share';
import {
  buildShareOriginContext,
  defaultShareOriginSources,
  relayShareAccessUrl,
  setShareOriginAttachedUplink,
  startShareRelayPriming,
} from '../../../../apps/gateway/src/share/share-origins';
import { getBaseVersion } from '../../../../apps/gateway/src/system/version';
import type { LocalAuthContext } from '../lib/local-auth';
import { type VibeTermRoles, isStandaloneRoles, parseVibeTermRoles } from '../lib/roles';
import { HttpsListener } from '../tls/https-listener';
import type { TlsService } from '../tls/tls-service';
import {
  MASTER_KEY_RECOVERY_HINT,
  createAssembleAuthSurface,
  isRelayOnly,
  resolveLocalAuthEffective,
  syncLocalSiteNameFromMesh,
} from './assemble-auth';
import { withRuntimeDiagnostics } from './assemble-diagnostics';
import { createAssembledRelay } from './assemble-relay';
import {
  buildHttpAndWs,
  buildLocalRouteDeps,
  createAssembledLifecycle,
  tryStop,
  wireTlsLifecycle,
} from './assemble-routes';
import { createVibeTermGatewayRuntime } from './gateway';
import { handleLocalRequest } from './local-routes';
import { type RuntimeMode, handlePreflightHttp, readRuntimeMode } from './mode';
import { serveFrontend as defaultServeFrontend } from './serve-frontend';
import { SETUP_RESTART_DELAY_MS } from './setup-service';

export {
  SHUTDOWN_TIMEOUT_MS,
  createProcessShutdown,
  installShutdownHandlers,
} from './assemble-shutdown';
export { MASTER_KEY_RECOVERY_HINT, isRelayOnly };

export async function startTlsWithRecovery(
  tls: Pick<TlsService, 'startup' | 'stop'>
): Promise<void> {
  try {
    await tls.startup();
  } catch (error) {
    if (!(error instanceof CryptoDecryptError)) throw error;
    tls.stop();
    console.error(
      `[vibeterm][tls] master_key_mismatch; HTTPS disabled, local HTTP remains available. ${MASTER_KEY_RECOVERY_HINT}`,
      error
    );
  }
}

export function meshShutdownNeeded(roles: VibeTermRoles): boolean {
  return roles.hub || roles.node || roles.relay;
}

type AssembleVibeTermOptions = {
  roles?: VibeTermRoles;
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

type AssembledVibeTerm = {
  roles: VibeTermRoles;
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
  return process.env.VIBETERM_FE_DIST_DIR
    ? resolve(process.env.VIBETERM_FE_DIST_DIR)
    : resolve(import.meta.dir, '../../resources/fe-dist');
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

async function assemblePreflightVibeTerm(
  opts: AssembleVibeTermOptions
): Promise<AssembledVibeTerm> {
  const roles = opts.roles ?? parseVibeTermRoles(process.env.VIBETERM_ROLES);
  const createGateway =
    opts.createGatewayRuntime ??
    (() => createVibeTermGatewayRuntime(undefined, { mode: 'preflight' }));
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

async function relayOnlyFrontend(): Promise<Response> {
  return new Response(JSON.stringify({ error: { code: 'RELAY_NO_FRONTEND' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

function maybeMeshHubStore(
  roles: VibeTermRoles,
  db: GatewayRuntime['db']
): MeshHubStore | undefined {
  return roles.hub || roles.node ? new MeshHubStore(db) : undefined;
}

function applySiteSettingsLink(
  roles: VibeTermRoles,
  mesh: MeshRuntime | null,
  meshHubStore: MeshHubStore | undefined,
  db: GatewayRuntime['db']
): void {
  setSiteAccessOriginsProvider(
    () => buildShareOriginContext(defaultShareOriginSources, null).candidates
  );
  setShareOriginAttachedUplink(() => mesh?.attachedHub()?.publicUrl ?? null);
  if (roles.hub || roles.node) {
    const relayStore = new MeshRelayStore(db);
    setSiteSettingsLinkProvider(
      createMeshSiteSettingsLink({
        roles,
        localNodeId: () => mesh?.nodeId ?? null,
        hubStore: meshHubStore ?? null,
        attachedHub: () => mesh?.attachedHub() ?? null,
        hubPublicUrl: gatewayConfig.hubPublicUrl,
        hubMetaPublicUrl: () => mesh?.userStore.getHubMeta()?.publicUrl ?? null,
        uplinkKind: () => relayStore.uplinkKind(),
        storedSiteUrl: () => getStoredSiteSettings().siteUrl || null,
        relayAccessUrl: () => relayShareAccessUrl(),
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

type AssembleCore = {
  roles: VibeTermRoles;
  gateway: GatewayRuntime;
  mesh: MeshRuntime | null;
  authHttp: MeshHttpRuntime | null;
  hub: HubRuntime | null;
  auth: LocalAuthContext;
  degraded: 'master_key_mismatch' | null;
  tlsSlot: { service?: TlsService };
  meshHubStore: MeshHubStore | undefined;
  inboundHttpExtensions: NonNullable<CreateMeshRuntimeOptions['inboundHttpExtensions']>;
  serveFrontend: (req: Request, staticRoot: string) => Promise<Response>;
  staticRoot: string;
  localAuthEffective: () => boolean;
};

async function assembleCore(opts: AssembleVibeTermOptions): Promise<AssembleCore> {
  const roles = opts.roles ?? parseVibeTermRoles(process.env.VIBETERM_ROLES);
  const staticRoot = opts.staticRoot ?? defaultStaticRoot();
  const runtimeMode = opts.runtimeMode ?? readRuntimeMode();
  const createGateway =
    opts.createGatewayRuntime ??
    (() => createVibeTermGatewayRuntime(undefined, { mode: runtimeMode }));
  const inboundHttpExtensions: NonNullable<CreateMeshRuntimeOptions['inboundHttpExtensions']> = [];
  const createMesh = (meshOpts: CreateMeshRuntimeOptions) =>
    (opts.createMeshRuntime ?? createMeshRuntime)({ ...meshOpts, inboundHttpExtensions });
  const serveFrontend =
    opts.serveFrontend ?? (isRelayOnly(roles) ? relayOnlyFrontend : defaultServeFrontend);
  const gateway = await createGateway();
  const tlsSlot: { service?: TlsService } = {};
  const meshHubStore = maybeMeshHubStore(roles, gateway.db);
  const { auth, mesh, authHttp, hub, degraded } = await createAssembleAuthSurface({
    roles,
    gateway,
    opts,
    createMesh,
    tlsSlot,
    meshHubStore,
    onLocalNodeName: syncLocalSiteNameFromMesh,
  });
  applySiteSettingsLink(roles, mesh, meshHubStore, gateway.db);
  const localAuthEffective = resolveLocalAuthEffective(opts.localAuthEffective, authHttp);
  getShareService().setAuthRequiredResolver(
    () => !isStandaloneRoles(roles) || localAuthEffective()
  );
  if (roles.hub) {
    console.log(
      `[hub] mode=${gatewayConfig.hubMode} priority=${gatewayConfig.hubPriority} writerEpoch=${gatewayConfig.hubWriterEpoch} publicUrl=${gatewayConfig.hubPublicUrl ?? ''}`
    );
  }
  return {
    roles,
    gateway,
    mesh,
    authHttp,
    hub,
    auth,
    degraded,
    tlsSlot,
    meshHubStore,
    inboundHttpExtensions,
    serveFrontend,
    staticRoot,
    localAuthEffective,
  };
}

async function assembleHttpAndLifecycle(core: AssembleCore): Promise<AssembledVibeTerm> {
  const unsubscribeNodeList = subscribeReplicatedNodeList(core.mesh, core.hub);
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
    roles: core.roles,
    auth: core.auth,
    mesh: core.mesh,
    hub: core.hub,
    tlsSlot: core.tlsSlot,
    scheduleRestart,
    localAuthEffective: core.localAuthEffective,
  });
  core.inboundHttpExtensions.push(async (req) => {
    const path = new URL(req.url).pathname;
    return path === '/api/local/status' || path === '/api/local/direct'
      ? handleLocalRequest(req, routeDeps)
      : null;
  });
  const relay = await createAssembledRelay({
    roles: core.roles,
    gateway: core.gateway,
    routeDeps,
  });
  const http = buildHttpAndWs({
    gateway: core.gateway,
    mesh: core.mesh,
    hub: core.hub,
    relay,
    authHttp: core.authHttp,
    routeDeps,
    serveFrontend: core.serveFrontend,
    staticRoot: core.staticRoot,
  });
  http.fetch = withRuntimeDiagnostics(http.fetch, core.auth, core.mesh, core.degraded);
  const tlsLife = wireTlsLifecycle({
    http,
    gateway: core.gateway,
    routeDeps,
    tlsSlot: core.tlsSlot,
    authHttp: core.authHttp,
    mesh: core.mesh,
    hub: core.hub,
  });
  const lifecycle = createAssembledLifecycle({
    mesh: core.mesh,
    gateway: core.gateway,
    authHttp: core.authHttp,
    hub: core.hub,
    relay,
    unsubscribeNodeList,
    shutdown,
  });
  return attachRelayPriming(
    {
      roles: core.roles,
      gateway: core.gateway,
      mesh: core.mesh,
      hub: core.hub,
      relay,
      tls: tlsLife.tls,
      httpsListener: tlsLife.httpsListener,
      fetch: http.fetch,
      websocket: http.websocket,
      ...lifecycle,
    },
    core.roles
  );
}

function attachRelayPriming(assembled: AssembledVibeTerm, roles: VibeTermRoles): AssembledVibeTerm {
  let stopRelayPriming: (() => void) | null = null;
  return {
    ...assembled,
    async start() {
      await assembled.start();
      if (roles.hub || roles.node) stopRelayPriming ??= startShareRelayPriming();
    },
    async stop() {
      stopRelayPriming?.();
      stopRelayPriming = null;
      await assembled.stop();
    },
  };
}

export async function assembleVibeTerm(
  opts: AssembleVibeTermOptions = {}
): Promise<AssembledVibeTerm> {
  const runtimeMode = opts.runtimeMode ?? readRuntimeMode();
  if (runtimeMode === 'preflight') return assemblePreflightVibeTerm(opts);
  const core = await assembleCore(opts);
  return assembleHttpAndLifecycle(core);
}
