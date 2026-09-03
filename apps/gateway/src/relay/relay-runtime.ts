import { type ServerSocketAdapter, WebSocketLink } from '@tmex/shared/link';
import { matchPath } from '../api/route';
import type { AuthDb } from '../auth/types';
import {
  type RelayAdminAuth,
  type RelayLocalAuthCheck,
  createRelayAdminAuth,
  ensureRelayAdminToken,
} from './relay-admin-auth';
import {
  type RelayAdminDeps,
  handleRelayConfigPatch,
  handleRelayPassword,
  handleRelayTenantDelete,
  handleRelayTenantKick,
  handleRelayTenantPatch,
  relayStatusPayload,
} from './relay-admin-routes';
import { RelayConfigStore } from './relay-config-store';
import { RelayEnrollLimiter } from './relay-enroll-limiter';
import { RelayErrorCode, relayError } from './relay-http';
import { RelayKeyLogStore } from './relay-key-log-store';
import { RelayMetering } from './relay-metering';
import type { RelaySleep } from './relay-quota';
import { RelayRegistry } from './relay-registry';
import {
  type RelayPublicRoutesDeps,
  handleRelayEnroll,
  handleRelayEnrollmentLookup,
  handleRelayRedeem,
  relayHealth,
} from './relay-routes';
import { RelayTenantStore } from './relay-tenant-store';
import { RelayUplinkServer } from './relay-uplink-server';
import {
  RELAY_UPLINK_PATH,
  RELAY_UPLINK_WS_KIND,
  type RelayRuntimeConfig,
  type RelayServerWebSocket,
  type RelayUpgradeServer,
  type RelayUplinkSocketData,
} from './types';

export type RelayRuntimeOptions = {
  db: AuthDb;
  config: RelayRuntimeConfig;
  now?: () => number;
  sleep?: RelaySleep;
  startedAt?: number;
  version?: string;
  /** `relay,node` 时注入：本机 node-session 也算管理员。 */
  isLocalUserAuthenticated?: RelayLocalAuthCheck;
  /** production 才注入：首启生成的管理令牌写回 app.env。 */
  patchEnv?: (patch: Record<string, string>) => Promise<void>;
  clientIp?: (req: Request) => string;
  meterFlushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatMissLimit?: number;
  authTimeoutMs?: number;
  listDebounceMs?: number;
  minClientVersion?: string;
  log?: (line: string) => void;
};

/** 与 hub 的 BunServerWsAdapter 等价，只是挂在 relay 的 socket data 上。 */
export class RelayServerWsAdapter implements ServerSocketAdapter {
  private messageCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: ((reason?: string) => void) | null = null;
  private drainCb: (() => void) | null = null;

  constructor(private readonly socket: RelayServerWebSocket) {}

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

export class RelayRuntime {
  readonly tenants: RelayTenantStore;
  readonly keyLog: RelayKeyLogStore;
  readonly configStore: RelayConfigStore;
  readonly registry: RelayRegistry;
  readonly metering: RelayMetering;
  readonly uplink: RelayUplinkServer;
  readonly limiter: RelayEnrollLimiter;
  readonly adminAuth: RelayAdminAuth;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly version: string;
  private readonly publicDeps: RelayPublicRoutesDeps;
  private readonly adminDeps: RelayAdminDeps;

  constructor(opts: RelayRuntimeOptions, adminAuth: RelayAdminAuth) {
    this.now = opts.now ?? Date.now;
    this.startedAt = opts.startedAt ?? this.now();
    this.version = opts.version ?? opts.config.version ?? 'unknown';
    this.tenants = new RelayTenantStore(opts.db);
    this.keyLog = new RelayKeyLogStore(opts.db);
    this.configStore = new RelayConfigStore(opts.db);
    this.registry = new RelayRegistry();
    this.metering = new RelayMetering(this.tenants, this.now, opts.meterFlushIntervalMs, () =>
      this.uplink.sweepEnrollments()
    );
    this.limiter = new RelayEnrollLimiter(this.now);
    this.adminAuth = adminAuth;
    this.uplink = new RelayUplinkServer({
      db: opts.db,
      tenants: this.tenants,
      keyLog: this.keyLog,
      configStore: this.configStore,
      registry: this.registry,
      metering: this.metering,
      config: opts.config,
      now: this.now,
      sleep: opts.sleep,
      heartbeatIntervalMs: opts.heartbeatIntervalMs,
      heartbeatMissLimit: opts.heartbeatMissLimit,
      authTimeoutMs: opts.authTimeoutMs,
      listDebounceMs: opts.listDebounceMs,
      minClientVersion: opts.minClientVersion,
    });
    this.publicDeps = {
      tenants: this.tenants,
      keyLog: this.keyLog,
      configStore: this.configStore,
      limiter: this.limiter,
      uplink: this.uplink,
      publicUrl: opts.config.publicUrl,
      relayHost: this.uplink.relayHost,
      now: this.now,
      clientIp: opts.clientIp ?? (() => ''),
    };
    this.adminDeps = {
      tenants: this.tenants,
      keyLog: this.keyLog,
      configStore: this.configStore,
      registry: this.registry,
      metering: this.metering,
      uplink: this.uplink,
      now: this.now,
    };
    this.metering.start();
  }

  async handleRequest(req: Request, server: RelayUpgradeServer): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    if (path === RELAY_UPLINK_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return relayError(RelayErrorCode.methodNotAllowed, 405);
      }
      const ok = server.upgrade(req, {
        data: { kind: RELAY_UPLINK_WS_KIND } satisfies RelayUplinkSocketData,
      });
      return ok ? undefined : relayError(RelayErrorCode.upgradeFailed, 426);
    }
    if (!path.startsWith('/api/relay/')) return undefined;
    return (await this.routePublic(req, path)) ?? (await this.routeAdmin(req, path));
  }

  private async routePublic(req: Request, path: string): Promise<Response | undefined> {
    if (matchPath(path, '/api/relay/health')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return relayError(RelayErrorCode.methodNotAllowed, 405);
      }
      return relayHealth({
        version: this.version,
        tenants: this.tenants.count(),
        nodesOnline: this.registry.onlineCount(),
        startedAt: this.startedAt,
        now: this.now(),
      });
    }
    if (matchPath(path, '/api/relay/enroll')) {
      if (req.method !== 'POST') return relayError(RelayErrorCode.methodNotAllowed, 405);
      return handleRelayEnroll(this.publicDeps, req);
    }
    const redeem = matchPath(path, '/api/relay/tenants/:tenantId/enrollments/redeem');
    if (redeem) {
      if (req.method !== 'POST') return relayError(RelayErrorCode.methodNotAllowed, 405);
      return handleRelayRedeem(this.publicDeps, req, decodeURIComponent(redeem.tenantId));
    }
    const lookup = matchPath(path, '/api/relay/tenants/:tenantId/enrollments/:enrollPk');
    if (lookup) {
      if (req.method !== 'GET') return relayError(RelayErrorCode.methodNotAllowed, 405);
      return handleRelayEnrollmentLookup(
        this.publicDeps,
        req,
        decodeURIComponent(lookup.tenantId),
        decodeURIComponent(lookup.enrollPk)
      );
    }
    return undefined;
  }

  private async routeAdmin(req: Request, path: string): Promise<Response> {
    const route = matchAdminRoute(req, path);
    if (!route) return relayError(RelayErrorCode.notFound, 404);
    if (route instanceof Response) return route;
    if (!(await this.adminAuth.authorize(req))) {
      return relayError(RelayErrorCode.unauthorized, 401);
    }
    switch (route.kind) {
      case 'status':
        return relayStatusPayload(this.adminDeps);
      case 'password':
        return handleRelayPassword(this.adminDeps, req);
      case 'config':
        return handleRelayConfigPatch(this.adminDeps, req);
      case 'tenant-patch':
        return handleRelayTenantPatch(this.adminDeps, req, route.tenantId);
      case 'tenant-kick':
        return handleRelayTenantKick(this.adminDeps, route.tenantId);
      case 'tenant-delete':
        return handleRelayTenantDelete(this.adminDeps, route.tenantId);
    }
  }

  isUplinkSocket(ws: { data?: { kind?: string } }): boolean {
    return ws.data?.kind === RELAY_UPLINK_WS_KIND;
  }

  handleUplinkOpen(ws: RelayServerWebSocket): void {
    const adapter = new RelayServerWsAdapter(ws);
    ws.data.adapter = adapter;
    this.uplink.accept(new WebSocketLink(adapter, { role: 'acceptor' }));
  }

  handleUplinkMessage(ws: RelayServerWebSocket, message: string | ArrayBuffer | Uint8Array): void {
    (ws.data.adapter as RelayServerWsAdapter | undefined)?.dispatchMessage(message);
  }

  handleUplinkClose(ws: RelayServerWebSocket, code?: number, reason?: string): void {
    (ws.data.adapter as RelayServerWsAdapter | undefined)?.dispatchClose(code, reason);
  }

  handleUplinkDrain(ws: RelayServerWebSocket): void {
    (ws.data.adapter as RelayServerWsAdapter | undefined)?.dispatchDrain();
  }

  async stop(): Promise<void> {
    await this.uplink.stop();
    this.metering.stop();
  }
}

type AdminRoute =
  | { kind: 'status' | 'password' | 'config' }
  | { kind: 'tenant-patch' | 'tenant-kick' | 'tenant-delete'; tenantId: string };

function matchAdminRoute(req: Request, path: string): AdminRoute | Response | null {
  const wrongMethod = relayError(RelayErrorCode.methodNotAllowed, 405);
  if (matchPath(path, '/api/relay/status')) {
    return req.method === 'GET' ? { kind: 'status' } : wrongMethod;
  }
  if (matchPath(path, '/api/relay/password')) {
    return req.method === 'POST' ? { kind: 'password' } : wrongMethod;
  }
  if (matchPath(path, '/api/relay/config')) {
    return req.method === 'PATCH' ? { kind: 'config' } : wrongMethod;
  }
  const kick = matchPath(path, '/api/relay/tenants/:id/kick');
  if (kick) {
    return req.method === 'POST'
      ? { kind: 'tenant-kick', tenantId: decodeURIComponent(kick.id) }
      : wrongMethod;
  }
  const tenant = matchPath(path, '/api/relay/tenants/:id');
  if (tenant) {
    const tenantId = decodeURIComponent(tenant.id);
    if (req.method === 'PATCH') return { kind: 'tenant-patch', tenantId };
    if (req.method === 'DELETE') return { kind: 'tenant-delete', tenantId };
    return wrongMethod;
  }
  return null;
}

export async function createRelayRuntime(opts: RelayRuntimeOptions): Promise<RelayRuntime> {
  const now = opts.now ?? Date.now;
  const configStore = new RelayConfigStore(opts.db);
  await ensureRelayAdminToken({
    configuredToken: opts.config.adminToken ?? null,
    store: configStore,
    now,
    patchEnv: opts.patchEnv,
    log: opts.log,
  });
  const adminAuth = createRelayAdminAuth({
    configuredToken: opts.config.adminToken ?? null,
    store: configStore,
    now,
    isLocalUserAuthenticated: opts.isLocalUserAuthenticated,
  });
  return new RelayRuntime(opts, adminAuth);
}
