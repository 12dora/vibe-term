import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { errorMessage } from '@tmex/shared';
import type {
  TunnelAccessMode,
  TunnelAccessStatus,
  TunnelActionRequest,
  TunnelActionResponse,
  TunnelBinaryStatus,
  TunnelConnectorStatus,
  TunnelEdgeResolution,
  TunnelErrorResponse,
  TunnelJobKind,
  TunnelJobStatus,
  TunnelMode,
  TunnelProcessState,
  TunnelStatusResponse,
} from '@tmex/shared';
import { PROCESS_STARTED_AT } from '../api/system-routes';
import { config, originUrlFromBindHost } from '../config';
import { getDb as getOrmDb } from '../db/client';
import { defaultLoginEnforced } from '../db/local-auth-settings';
import { CloudflareAccessClient, type TunnelFetch, sanitizeAccessMessage } from './access-client';
import { setAccessGuardSource, setAccessJwtVerifier } from './access-guard';
import { AccessJwtVerifier } from './access-jwt';
import { type AccessControlAction, isAccessControlAction, processUp } from './access-mode';
import { parseAccessRules } from './access-rules';
import {
  MemoryTunnelAccessStore,
  TunnelAccessStore,
  type TunnelAccessStoreLike,
  emptyAccessStatus,
} from './access-store';
import {
  DEFAULT_TUNNEL_CONFIG,
  TunnelConfigStore,
  type TunnelConfigStoreLike,
  type TunnelPersisted,
} from './config-store';
import {
  EMPTY_CONNECTOR,
  discoverMetricsAddr,
  extractLastError,
  isAccessProtectedHealthResponse,
  probeConnector,
  readLogTail,
} from './connector-health';
import { ConnectorPollLoop } from './connector-poll';
import { type Downloader, defaultDownloader, installCloudflaredBinary } from './download';
import { gatewayKvEdgeCache } from './edge-cache';
import { type EdgeRecoveryToken, TunnelEdgeRecovery } from './edge-recovery';
import { resolveEdge } from './edge-resolver';
import {
  EXPOSURE_ACK_MESSAGE,
  EXTERNAL_MANAGED_MESSAGE,
  HOST_ENV_MESSAGE,
  TunnelError,
  tunnelErrorFrom,
  tunnelHttpStatus,
} from './errors';
import {
  EMPTY_EXTERNAL,
  type ExternalDetectDeps,
  type ExternalDetection,
  ExternalTunnelDetector,
  toExternalStatus,
} from './external-detect';
import {
  defaultTunnelName,
  normalizeTunnelHostname,
  normalizeTunnelName,
  resolveAccessHostname,
} from './hostname';
import { LogRingBuffer } from './log-buffer';
import { writeNamedConfigYml } from './named-config';
import {
  ensureManagedOriginCert,
  isOriginCertPresent,
  readArgoCertCredentials,
} from './origin-cert';
import { isTunnelPlatformSupported, tunnelPlatformLabel } from './platform';
import {
  CloudflaredProvider,
  configYmlPath,
  credentialsPathFor,
  managedBinaryPath,
  originCertPath,
  parseLoginUrl,
} from './provider';
import { redactSecrets } from './redact';
import { type PickPort, type Spawner, bunSpawner, consumeLines, pickFreePort } from './spawn';
import {
  buildAccessStatus,
  buildTunnelStatus,
  connectorHintText,
  edgeHintText,
  tunnelProcessState,
} from './status-view';
import { TunnelSupervisor } from './supervisor';
type PatchHostEnv = (trustProxy: boolean) => Promise<void>;
type ReadHostEnv = () => Promise<boolean | null>;

export type TunnelManagerOptions = {
  tunnelDir?: string;
  homeDir?: string;
  originPort?: number;
  originUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  store?: TunnelConfigStoreLike;
  spawner?: Spawner;
  which?: (cmd: string) => string | null;
  downloader?: Downloader;
  fetchImpl?: TunnelFetch;
  patchHostEnv?: PatchHostEnv | null;
  readHostEnv?: ReadHostEnv | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  loginTimeoutMs?: number;
  loginPollMs?: number;
  killTimeoutMs?: number;
  healthzStartedAt?: number;
  trustProxy?: boolean;
  configuredTrustProxy?: boolean;
  probeVersionOnStart?: boolean;
  runningWaitMs?: number;
  loginEnforced?: () => boolean;
  warn?: (message: string) => void;
  accessStore?: TunnelAccessStoreLike;
  accessClient?: CloudflareAccessClient;
  externalDetect?: ExternalTunnelDetector;
  externalDetectDeps?: Partial<ExternalDetectDeps>;
  registerAccessGuard?: boolean;
  hasMeshRole?: boolean;
  ackDetectMs?: number;
  pickPort?: PickPort;
  /** 连接器轮询间隔；测试默认 0（关闭），生产默认 30s */
  connectorPollMs?: number;
  /** 无已知 metrics 地址时是否扫描 127.0.0.1:20241–20245；测试默认关闭以免碰到本机生产 cloudflared */
  scanDefaultMetrics?: boolean;
  resolveEdge?: () => Promise<TunnelEdgeResolution | null>;
  edgeRecoveryDelayMs?: number;
};

type BinaryCache = {
  path: string | null;
  source: TunnelBinaryStatus['source'];
  version: string | null;
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 500;
const EDGE_RECOVERY_DELAY_MS = 90_000;

export class TunnelManager {
  private readonly tunnelDir: string;
  private readonly homeDir: string;
  private readonly originPort: number;
  private readonly originUrl: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly store: TunnelConfigStoreLike;
  private readonly which: (cmd: string) => string | null;
  private readonly downloader: Downloader;
  private readonly fetchImpl: TunnelFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly loginTimeoutMs: number;
  private readonly loginPollMs: number;
  private readonly healthzStartedAt: number;
  private readonly runningWaitMs: number;
  private readonly logs = new LogRingBuffer(200);
  private readonly provider: CloudflaredProvider;
  private readonly supervisor: TunnelSupervisor;
  private readonly probeVersionOnStart: boolean;
  private readonly warn: (message: string) => void;
  private readonly accessStore: TunnelAccessStoreLike;
  private readonly accessClient: CloudflareAccessClient;
  private readonly jwtVerifier: AccessJwtVerifier;
  private readonly externalDetector: ExternalTunnelDetector;
  private readonly hasMeshRole: boolean;
  private readonly ackDetectMs: number;
  private lastExternal: ExternalDetection = { ...EMPTY_EXTERNAL };
  private lastConnector: TunnelConnectorStatus = { ...EMPTY_CONNECTOR };
  private lastEdge: TunnelEdgeResolution | null = null;
  private readonly resolveEdgeFn: () => Promise<TunnelEdgeResolution | null>;
  private readonly edgeRecovery: TunnelEdgeRecovery;
  private readonly connectorPollMs: number;
  private readonly scanDefaultMetrics: boolean;
  private readonly connectorPoll: ConnectorPollLoop;
  private connectorProbeInFlight: Promise<TunnelConnectorStatus> | null = null;
  private logTailCache: { at: number; path: string; lines: string[] } | null = null;
  private loginEnforcedFn: () => boolean;
  private trustProxy: boolean;
  private configuredTrustProxy: boolean;
  private patchHostEnv: PatchHostEnv | null;
  private readHostEnv: ReadHostEnv | null;
  private restartRequired = false;
  private job: TunnelJobStatus | null = null;
  private loginHandle: { kill: (signal?: NodeJS.Signals) => void; exited: Promise<number> } | null =
    null;
  private loginCancelled = false;
  private loginUrl: string | null = null;
  private binary: BinaryCache = { path: null, source: null, version: null };
  private lastStartOpts: {
    bin: string;
    mode: 'named' | 'quick';
    originUrl: string;
    configPath: string;
  } | null = null;

  constructor(opts: TunnelManagerOptions = {}) {
    this.tunnelDir = opts.tunnelDir ?? config.tunnelDir;
    this.homeDir = opts.homeDir ?? homedir();
    this.originPort = opts.originPort ?? config.port;
    this.originUrl = opts.originUrl ?? originUrlFromBindHost(config.bindHost, this.originPort);
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.store = opts.store ?? new TunnelConfigStore(getOrmDb());
    this.which = opts.which ?? ((cmd) => Bun.which(cmd) ?? null);
    this.downloader = opts.downloader ?? defaultDownloader;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.patchHostEnv = opts.patchHostEnv ?? null;
    this.readHostEnv = opts.readHostEnv ?? null;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.loginTimeoutMs = opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.loginPollMs = opts.loginPollMs ?? LOGIN_POLL_MS;
    this.healthzStartedAt = opts.healthzStartedAt ?? PROCESS_STARTED_AT;
    this.runningWaitMs = opts.runningWaitMs ?? 30_000;
    this.trustProxy = opts.trustProxy ?? config.trustProxy;
    this.configuredTrustProxy = opts.configuredTrustProxy ?? this.trustProxy;
    this.restartRequired = this.configuredTrustProxy !== this.trustProxy;
    this.probeVersionOnStart = opts.probeVersionOnStart ?? false;
    this.loginEnforcedFn = opts.loginEnforced ?? (() => defaultLoginEnforced());
    this.hasMeshRole = opts.hasMeshRole ?? (config.roles.hub || config.roles.node);
    this.ackDetectMs = opts.ackDetectMs ?? 3_000;
    this.connectorPollMs = opts.connectorPollMs ?? (config.isTest ? 0 : 30_000);
    this.scanDefaultMetrics = opts.scanDefaultMetrics ?? !config.isTest;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.accessStore =
      opts.accessStore ??
      (opts.store ? new MemoryTunnelAccessStore() : new TunnelAccessStore(getOrmDb()));
    this.accessClient = opts.accessClient ?? new CloudflareAccessClient(this.fetchImpl);
    this.jwtVerifier = new AccessJwtVerifier({ fetchImpl: this.fetchImpl, now: this.now });
    this.externalDetector =
      opts.externalDetect ??
      new ExternalTunnelDetector({
        originPort: this.originPort,
        now: this.now,
        platform: this.platform,
        accessClient: this.accessClient,
        warn: (message) => this.warn(message),
        configuredHostnames: () => {
          const hostname = this.safePersisted().hostname;
          return hostname ? [hostname] : [];
        },
        ...opts.externalDetectDeps,
        getCredentials:
          opts.externalDetectDeps?.getCredentials ?? (() => this.detectionCredentials()),
      });
    if (opts.registerAccessGuard !== false) {
      setAccessGuardSource(() => this.accessGuardState());
      setAccessJwtVerifier(this.jwtVerifier);
    }
    this.resolveEdgeFn =
      opts.resolveEdge ??
      (config.isTest
        ? async () => null
        : () =>
            resolveEdge({
              fetchImpl: this.fetchImpl,
              now: this.now,
              cache: gatewayKvEdgeCache(),
            }));
    this.edgeRecovery = new TunnelEdgeRecovery({
      now: () => this.now(),
      delayMs: opts.edgeRecoveryDelayMs ?? EDGE_RECOVERY_DELAY_MS,
      resolveEdge: () => this.resolveEdgeFn(),
      currentEdge: () => this.currentEdge(),
      canRestart: () => Boolean(this.lastStartOpts) && this.isManagedProcessActive(),
      restart: (edge, token) => this.restartWithEdge(edge, token),
      warn: (message) => this.warn(message),
    });
    this.connectorPoll = new ConnectorPollLoop({
      intervalMs: this.connectorPollMs,
      sleep: (ms) => this.sleep(ms),
      shouldProbe: () => this.shouldProbeConnector(),
      probe: () => this.probeAndStoreConnector(),
      onSample: async (connector) => {
        if (this.safePersisted().externallyManaged) return;
        await this.edgeRecovery.maybeRecover(connector);
      },
    });
    const spawner: Spawner = opts.spawner ?? bunSpawner;
    this.provider = new CloudflaredProvider(
      spawner,
      this.tunnelDir,
      opts.pickPort ?? pickFreePort,
      {
        resolveEdge: () => this.resolveEdgeFn(),
        log: (message) => this.warn(message),
      }
    );
    this.supervisor = new TunnelSupervisor({
      provider: this.provider,
      logs: this.logs,
      sleep: this.sleep,
      killTimeoutMs: opts.killTimeoutMs ?? 5_000,
      onPublicUrl: (url) => {
        this.supervisor.publicUrl = url;
      },
    });
  }

  setPatchHostEnv(fn: PatchHostEnv | null): void {
    this.patchHostEnv = fn;
  }
  setReadHostEnv(fn: ReadHostEnv | null): void {
    this.readHostEnv = fn;
    void this.refreshConfiguredTrustProxy();
  }
  setLoginEnforced(fn: () => boolean): void {
    this.loginEnforcedFn = fn;
  }

  async start(): Promise<void> {
    await mkdir(this.tunnelDir, { recursive: true }).catch(() => {});
    this.refreshBinaryPresence();
    await this.refreshConfiguredTrustProxy();
    if ((this.probeVersionOnStart || !config.isTest) && this.binary.path) {
      await this.probeVersion();
    }
    const persisted = this.store.get();
    void this.refreshExternal().catch((e) => this.warn(`[tunnel] external warmup failed: ${e}`));
    if (persisted.autoStart && persisted.mode !== 'off' && !persisted.externallyManaged) {
      if (!this.isExposureProtected() && !persisted.exposureAcknowledgedAt) {
        this.warn(`[tunnel] auto-start skipped: ${EXPOSURE_ACK_MESSAGE}`);
      } else {
        try {
          await this.startProcess(persisted.mode);
        } catch (error) {
          this.supervisor.state = 'error';
          this.supervisor.lastError = tunnelErrorFrom(error).message;
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.loginHandle?.kill();
    this.loginHandle = null;
    this.resetConnector();
    this.resetEdge();
    await this.supervisor.stop();
  }

  status(): TunnelStatusResponse {
    this.refreshBinaryPresence();
    const persisted = this.safePersisted();
    const access = this.accessStatus();
    const loginEnforced = this.loginEnforcedFn();
    return buildTunnelStatus({
      platform: this.platform,
      arch: this.arch,
      binary: this.binary,
      persisted,
      loggedIn: isOriginCertPresent(this.tunnelDir, this.homeDir),
      loginUrl: this.job?.kind === 'login' && this.job.state === 'running' ? this.loginUrl : null,
      originPort: this.originPort,
      processState: this.processState(persisted),
      processAlive: persisted.externallyManaged
        ? this.lastExternal.running
        : processUp(this.supervisor.state),
      supervisor: {
        pid: this.supervisor.pid,
        startedAt: this.supervisor.startedAt,
        lastError: this.supervisor.lastError,
        restarts: this.supervisor.restarts,
        publicUrl: this.supervisor.publicUrl,
      },
      connector: this.lastConnector,
      connectorLastError: this.lastConnector.lastError,
      edge: persisted.externallyManaged ? null : this.currentEdge(),
      access,
      external: toExternalStatus(this.lastExternal),
      loginEnforced,
      exposureProtected: this.isExposureProtected(persisted, access, loginEnforced),
      job: this.job,
      trustProxy: this.trustProxy,
      configuredTrustProxy: this.configuredTrustProxy,
      restartRequired: this.restartRequired,
      log: this.statusLog(),
    });
  }

  async ensureFreshConnector(opts?: { maxWaitMs?: number }): Promise<void> {
    const maxWaitMs = opts?.maxWaitMs ?? 800;
    const logTail =
      this.safePersisted().externallyManaged && this.lastExternal.logFile
        ? this.refreshExternalLogTail()
        : Promise.resolve();
    if (!this.isConnectorStale()) {
      if (maxWaitMs <= 0) {
        void logTail;
        return;
      }
      await Promise.race([logTail, this.sleep(maxWaitMs)]);
      return;
    }
    const probe = Promise.all([this.probeAndStoreConnector(), logTail]);
    if (maxWaitMs <= 0) {
      void probe;
      return;
    }
    await Promise.race([probe, this.sleep(maxWaitMs)]);
  }

  async handleAction(
    body: TunnelActionRequest
  ): Promise<{ httpStatus: number; payload: TunnelActionResponse | TunnelErrorResponse }> {
    try {
      if (isAccessControlAction(body)) return await this.handleAccessControlAction(body);
      switch (body.action) {
        case 'install':
          return await this.enqueueJob('install', (step) => this.jobInstall(step));
        case 'login':
          return await this.enqueueJob('login', (step) => this.jobLogin(step));
        case 'cancel_login':
          this.cancelLogin();
          return this.ok(200);
        case 'create':
          this.requireNotExternallyManaged();
          await this.requireExposureAck(body.acknowledgeExposure);
          this.requireModeOff();
          this.assertCreateName(body.hostname, body.tunnelName);
          return await this.enqueueJob('create', (step) =>
            this.jobCreate(body.hostname, body.tunnelName, step)
          );
        case 'quick_start':
          this.requireNotExternallyManaged();
          await this.requireExposureAck(body.acknowledgeExposure);
          return await this.enqueueJob('start', (step) => this.jobQuickStart(step));
        case 'start':
          this.requireNotExternallyManaged();
          await this.requireExposureAck(body.acknowledgeExposure);
          return await this.enqueueJob('start', (step) => this.jobStart(step));
        case 'stop':
          this.requireNotExternallyManaged();
          return await this.enqueueJob('stop', (step) => this.jobStop(step));
        case 'remove':
          if (this.store.get().externallyManaged) {
            this.releaseExternal();
            return this.ok(200);
          }
          return await this.enqueueJob('remove', (step) => this.jobRemove(step));
        case 'check':
          return await this.enqueueJob('check', (step) => this.jobCheck(step));
        case 'set_auto_start':
          if (body.autoStart) {
            this.requireNotExternallyManaged();
            await this.requireExposureAck(body.acknowledgeExposure);
          }
          this.store.save({ autoStart: body.autoStart });
          return this.ok(200);
        case 'set_trust_proxy':
          await this.setTrustProxy(body.trustProxy);
          return this.ok(200);
        case 'adopt_external':
          await this.adoptExternal(body.hostname);
          return this.ok(200);
        default:
          throw new TunnelError('invalid_request', 'unknown action');
      }
    } catch (error) {
      const parsed = tunnelErrorFrom(error);
      const override = error instanceof TunnelError ? error.httpStatusOverride : undefined;
      return {
        httpStatus: tunnelHttpStatus(parsed.code, override),
        payload: { error: parsed },
      };
    }
  }

  private async handleAccessControlAction(
    body: AccessControlAction
  ): Promise<{ httpStatus: number; payload: TunnelActionResponse | TunnelErrorResponse }> {
    switch (body.action) {
      case 'set_access_credentials':
        await this.setAccessCredentials(body.apiToken, body.accountId);
        return this.ok(200);
      case 'clear_access_credentials':
        await this.clearAccessCredentials();
        return this.ok(200);
      case 'configure_access':
        return await this.enqueueJob('access', (step) =>
          this.jobConfigureAccess(body.rules, step, body.hostname)
        );
      case 'remove_access':
        await this.requireLastProtectionAck(body.acknowledgeExposure);
        return await this.enqueueJob('access', (step) => this.jobRemoveAccess(step));
      case 'sync_access':
        return await this.enqueueJob('access', (step) => this.jobSyncAccess(step, body.hostname));
      case 'set_access_enforce':
        await this.setAccessEnforce(body.enforceJwt, body.acknowledgeExposure);
        return this.ok(200);
      case 'set_access_mode':
        await this.setAccessMode(body.accessMode, {
          acknowledgeExposure: body.acknowledgeExposure,
        });
        return this.ok(200);
    }
  }

  async setAccessMode(
    mode: TunnelAccessMode,
    opts?: { acknowledgeExposure?: boolean }
  ): Promise<void> {
    if (mode === 'none' && !this.isExposureProtected()) {
      await this.requireLastProtectionAck(opts?.acknowledgeExposure);
    }
    this.store.save({ accessMode: mode });
  }

  private ok(httpStatus: number): { httpStatus: number; payload: TunnelActionResponse } {
    const status = this.status();
    return { httpStatus, payload: { status, job: status.job } };
  }
  private async enqueueJob(
    kind: TunnelJobKind,
    run: (step: (name: string) => void) => Promise<void>
  ): Promise<{ httpStatus: number; payload: TunnelActionResponse }> {
    if (this.job?.state === 'running') {
      throw new TunnelError('busy', 'A tunnel job is already running');
    }
    const job: TunnelJobStatus = {
      id: randomUUID(),
      kind,
      state: 'running',
      step: null,
      error: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
    };
    this.job = job;
    if (kind === 'login') this.loginCancelled = false;
    void this.executeJob(job, run);
    return this.ok(202);
  }
  private async executeJob(
    job: TunnelJobStatus,
    run: (step: (name: string) => void) => Promise<void>
  ): Promise<void> {
    try {
      await run((name) => {
        job.step = name;
      });
      job.state = 'done';
    } catch (error) {
      const parsed = tunnelErrorFrom(error);
      job.state = 'error';
      job.error = parsed;
      if (job.kind === 'check') job.step = parsed.code;
    } finally {
      job.finishedAt = new Date(this.now()).toISOString();
      if (job.kind === 'login') {
        this.loginHandle = null;
        this.loginUrl = null;
      }
    }
  }

  private requireNotExternallyManaged(): void {
    if (this.store.get().externallyManaged) {
      throw new TunnelError('invalid_request', EXTERNAL_MANAGED_MESSAGE, 409);
    }
  }
  private async requireExposureAck(acknowledgeExposure: boolean | undefined): Promise<void> {
    if (this.isExposureProtected()) return;
    if (acknowledgeExposure === true) {
      this.store.save({ exposureAcknowledgedAt: new Date(this.now()).toISOString() });
      return;
    }
    throw new TunnelError('exposure_ack_required', EXPOSURE_ACK_MESSAGE);
  }
  private isExposureProtected(
    persisted = this.safePersisted(),
    access = this.accessStatus(),
    loginEnforced = this.loginEnforcedFn()
  ): boolean {
    return loginEnforced || access.effective;
  }
  private isManagedProcessActive(): boolean {
    return this.supervisor.runningEnabled || processUp(this.supervisor.state);
  }
  private async requireLastProtectionAck(acknowledgeExposure: boolean | undefined): Promise<void> {
    if (this.loginEnforcedFn()) return;
    if (acknowledgeExposure === true) {
      this.store.save({ exposureAcknowledgedAt: new Date(this.now()).toISOString() });
      return;
    }
    const persisted = this.safePersisted();
    if (!persisted.externallyManaged && !this.isManagedProcessActive()) return;
    if (persisted.externallyManaged) {
      try {
        const raced = await Promise.race([
          this.externalDetector.detect({ force: true }),
          Bun.sleep(this.ackDetectMs).then(() => null),
        ]);
        if (raced && !raced.probing && !raced.running) {
          this.lastExternal = raced;
          return;
        }
      } catch {}
    }
    throw new TunnelError('exposure_ack_required', EXPOSURE_ACK_MESSAGE);
  }

  private accessGuardState() {
    const access = this.accessStatus();
    return {
      configured: access.configured,
      enforceJwt: access.enforceJwt,
      effective: access.effective,
      aud: access.aud,
      teamDomain: access.teamDomain,
    };
  }

  private accessStatus(): TunnelAccessStatus {
    try {
      return buildAccessStatus(this.accessStore.get(), this.safePersisted());
    } catch {
      return emptyAccessStatus();
    }
  }

  async refreshExternal(opts?: { force?: boolean }): Promise<void> {
    try {
      this.lastExternal = await this.externalDetector.detect(opts);
      await this.refreshExternalLogTail();
      if (opts?.force) await this.probeAndStoreConnector();
      this.connectorPoll.sync();
    } catch (error) {
      if (opts?.force) throw error;
      this.lastExternal = { ...EMPTY_EXTERNAL };
    }
  }
  private requireModeOff(): void {
    if (this.store.get().mode !== 'off') {
      throw new TunnelError('tunnel_exists', 'A tunnel is already configured; remove it first');
    }
  }
  private assertCreateName(hostnameRaw: string, tunnelNameRaw: string | undefined): void {
    if (!normalizeTunnelHostname(hostnameRaw)) {
      throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
    }
    if (tunnelNameRaw?.trim()) {
      if (!normalizeTunnelName(tunnelNameRaw)) {
        throw new TunnelError('invalid_request', 'tunnel name is not a valid identifier');
      }
    }
  }
  private requireSupported(): void {
    if (!isTunnelPlatformSupported(this.platform, this.arch)) {
      throw new TunnelError(
        'unsupported_platform',
        `unsupported platform ${tunnelPlatformLabel(this.platform, this.arch)}`
      );
    }
  }

  private requireBinary(): string {
    this.refreshBinaryPresence();
    if (!this.binary.path) {
      throw new TunnelError('binary_missing', 'cloudflared is not installed');
    }
    return this.binary.path;
  }

  private requireLogin(): void {
    if (!ensureManagedOriginCert(this.tunnelDir, this.homeDir)) {
      throw new TunnelError('not_logged_in', 'cloudflared is not logged in');
    }
  }

  /** 探测专用：accessStore 优先，否则只读解析 ~/.cloudflared/cert.pem，永不落库。 */
  private async detectionCredentials(): Promise<{
    accountId: string;
    apiToken: string;
    source?: 'store' | 'cert';
  } | null> {
    const apiToken = await this.accessStore.getApiToken();
    const accountId = this.accessStore.get().accountId;
    if (apiToken && accountId) return { accountId, apiToken, source: 'store' };
    const fromCert = readArgoCertCredentials(this.homeDir);
    if (!fromCert) return null;
    return { accountId: fromCert.accountId, apiToken: fromCert.apiToken, source: 'cert' };
  }

  private refreshBinaryPresence(): void {
    const managed = managedBinaryPath(this.tunnelDir);
    if (existsSync(managed)) {
      if (this.binary.path !== managed) {
        this.binary = { path: managed, source: 'managed', version: null };
      } else {
        this.binary.source = 'managed';
        this.binary.path = managed;
      }
      return;
    }
    const system = this.which('cloudflared');
    if (system) {
      if (this.binary.path !== system) {
        this.binary = { path: system, source: 'system', version: null };
      } else {
        this.binary.source = 'system';
        this.binary.path = system;
      }
      return;
    }
    this.binary = { path: null, source: null, version: null };
  }

  private async probeVersion(): Promise<void> {
    if (!this.binary.path) return;
    try {
      this.binary.version = await this.provider.version(this.binary.path);
    } catch {
      this.binary.version = null;
    }
  }

  private async jobInstall(step: (name: string) => void): Promise<void> {
    this.requireSupported();
    await mkdir(this.tunnelDir, { recursive: true });
    const dest = managedBinaryPath(this.tunnelDir);
    step('download');
    step('extract');
    await installCloudflaredBinary({
      tunnelDir: this.tunnelDir,
      destPath: dest,
      platform: this.platform,
      arch: this.arch,
      downloader: this.downloader,
    });
    this.binary = { path: dest, source: 'managed', version: null };
    step('verify');
    const version = await this.provider.version(dest);
    if (!version) {
      throw new TunnelError('download_failed', 'cloudflared --version did not produce a version');
    }
    this.binary.version = version;
  }

  private async jobLogin(step: (name: string) => void): Promise<void> {
    this.requireSupported();
    const bin = this.requireBinary();
    await mkdir(this.tunnelDir, { recursive: true });
    if (ensureManagedOriginCert(this.tunnelDir, this.homeDir)) {
      step('wait_cert');
      return;
    }
    step('login');
    const handle = this.provider.spawnLogin(bin);
    this.loginHandle = handle;
    this.loginUrl = null;
    const onLine = (line: string): void => {
      this.logs.push(line);
      const url = parseLoginUrl(line);
      if (url) this.loginUrl = url;
    };
    void consumeLines(handle.stdout, onLine);
    void consumeLines(handle.stderr, onLine);
    const deadline = this.now() + this.loginTimeoutMs;
    while (this.now() < deadline) {
      if (this.loginCancelled) {
        step('cancelled');
        return;
      }
      if (ensureManagedOriginCert(this.tunnelDir, this.homeDir)) {
        step('wait_cert');
        handle.kill('SIGTERM');
        await handle.exited.catch(() => {});
        this.loginHandle = null;
        return;
      }
      const exited = await Promise.race([
        handle.exited.then((code) => code),
        this.sleep(this.loginPollMs).then(() => null),
      ]);
      if (this.loginCancelled) {
        step('cancelled');
        return;
      }
      if (exited !== null) {
        if (ensureManagedOriginCert(this.tunnelDir, this.homeDir)) {
          step('wait_cert');
          this.loginHandle = null;
          return;
        }
        throw new TunnelError('process_failed', `cloudflared login exited with code ${exited}`);
      }
    }
    handle.kill('SIGKILL');
    throw new TunnelError('login_timeout', 'cloudflared login timed out');
  }

  private cancelLogin(): void {
    this.loginCancelled = true;
    this.loginHandle?.kill();
  }

  private async jobCreate(
    hostnameRaw: string,
    tunnelNameRaw: string | undefined,
    step: (name: string) => void
  ): Promise<void> {
    this.requireSupported();
    const bin = this.requireBinary();
    this.requireLogin();
    const hostname = normalizeTunnelHostname(hostnameRaw);
    if (!hostname) {
      throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
    }
    const tunnelName = normalizeTunnelName(
      tunnelNameRaw?.trim() ? tunnelNameRaw : defaultTunnelName(hostname)
    );
    if (!tunnelName) {
      throw new TunnelError('invalid_request', 'tunnel name is not a valid identifier');
    }
    await mkdir(this.tunnelDir, { recursive: true });
    const credFile = credentialsPathFor(this.tunnelDir, tunnelName);
    step('create');
    const created = await this.provider.createTunnel(bin, tunnelName, credFile);
    const credentialsPath = existsSync(created.credentialsPath)
      ? created.credentialsPath
      : existsSync(credFile)
        ? credFile
        : credentialsPathFor(this.tunnelDir, created.tunnelId);
    step('route_dns');
    await this.provider.routeDns(bin, tunnelName, hostname);
    const cert = originCertPath(this.tunnelDir);
    const yml = writeNamedConfigYml({
      tunnelId: created.tunnelId,
      credentialsPath,
      certPath: cert,
      hostname,
      originUrl: this.originUrl,
    });
    await writeFile(configYmlPath(this.tunnelDir), yml, 'utf8');
    this.store.save({
      mode: 'named',
      hostname,
      tunnelName,
      tunnelId: created.tunnelId,
    });
    step('start');
    await this.startProcess('named');
  }

  private async jobQuickStart(step: (name: string) => void): Promise<void> {
    this.requireSupported();
    this.requireBinary();
    this.store.save({
      mode: 'quick',
      hostname: null,
      tunnelName: null,
      tunnelId: null,
    });
    step('start');
    await this.startProcess('quick');
  }

  private async jobStart(step: (name: string) => void): Promise<void> {
    this.requireSupported();
    this.requireBinary();
    const persisted = this.store.get();
    if (persisted.mode === 'off') {
      throw new TunnelError('not_configured', 'tunnel is not configured');
    }
    step('start');
    await this.startProcess(persisted.mode);
  }

  private async jobStop(step: (name: string) => void): Promise<void> {
    step('stop');
    this.resetConnector();
    this.resetEdge();
    await this.supervisor.stop();
  }

  // 取消接管：只清本地配置，不停系统服务、不动 Cloudflare 上的隧道。
  private releaseExternal(): void {
    this.store.save({
      mode: 'off',
      hostname: null,
      tunnelName: null,
      tunnelId: null,
      externallyManaged: false,
      autoStart: false,
    });
    this.supervisor.publicUrl = null;
    this.supervisor.lastError = null;
  }

  private async jobRemove(step: (name: string) => void): Promise<void> {
    step('stop');
    this.resetConnector();
    this.resetEdge();
    await this.supervisor.stop();
    const persisted = this.store.get();
    await rm(configYmlPath(this.tunnelDir), { force: true }).catch(() => {});
    if (persisted.tunnelName) {
      await rm(credentialsPathFor(this.tunnelDir, persisted.tunnelName), { force: true }).catch(
        () => {}
      );
    }
    if (persisted.tunnelId) {
      await rm(credentialsPathFor(this.tunnelDir, persisted.tunnelId), { force: true }).catch(
        () => {}
      );
    }
    const bin = this.binary.path;
    if (bin && persisted.tunnelName) {
      await this.provider.deleteTunnel(bin, persisted.tunnelName).catch(() => {});
    }
    this.store.save({
      mode: 'off',
      hostname: null,
      tunnelName: null,
      tunnelId: null,
    });
    this.supervisor.publicUrl = null;
    this.supervisor.lastError = null;
    this.supervisor.restarts = 0;
  }

  private async jobCheck(step: (name: string) => void): Promise<void> {
    const status = this.status();
    const target =
      status.process.publicUrl ??
      (status.config.hostname ? `https://${status.config.hostname}` : null);
    if (!target) {
      throw new TunnelError('not_configured', 'no hostname or public URL to check');
    }
    const connector = await this.probeAndStoreConnector();
    if (connector.reachable === true && connector.readyConnections === 0) {
      throw new TunnelError(
        'connector_down',
        `${connector.lastError ?? 'cloudflared has no edge connections'}${edgeHintText(this.currentEdge())}`
      );
    }
    const url = `${target.replace(/\/$/, '')}/healthz`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      const res = await this.fetchImpl(url, { signal: ac.signal, redirect: 'manual' });
      if (isAccessProtectedHealthResponse(res)) {
        if (connector.reachable === true && (connector.readyConnections ?? 0) > 0) {
          step('access_protected');
        } else {
          step('access_protected_unverified');
        }
        return;
      }
      if (!res.ok) {
        throw new TunnelError(
          'unknown',
          `health check HTTP ${res.status}${this.connectorHint(connector)}`
        );
      }
      const body = (await res.json()) as { startedAt?: unknown };
      if (body.startedAt !== this.healthzStartedAt) {
        throw new TunnelError(
          'unknown',
          `health check startedAt mismatch: got ${String(body.startedAt)}, expected ${this.healthzStartedAt}`
        );
      }
      step('ok');
    } catch (error) {
      if (error instanceof TunnelError) throw error;
      const message = errorMessage(error);
      throw new TunnelError(
        'unknown',
        `health check failed: ${message}${this.connectorHint(connector)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async setTrustProxy(trustProxy: boolean): Promise<void> {
    if (!this.patchHostEnv) {
      throw new TunnelError('not_configured', HOST_ENV_MESSAGE);
    }
    await this.patchHostEnv(trustProxy);
    this.configuredTrustProxy = trustProxy;
    this.restartRequired = this.configuredTrustProxy !== this.trustProxy;
  }

  private async setAccessCredentials(apiTokenRaw: string, accountIdRaw: string): Promise<void> {
    const apiToken = apiTokenRaw.trim();
    const accountId = accountIdRaw.trim();
    if (!apiToken || !accountId) {
      throw new TunnelError('invalid_request', 'apiToken and accountId are required');
    }
    try {
      const { teamDomain } = await this.accessClient.getOrganization(accountId, apiToken);
      await this.accessStore.save({
        apiToken,
        accountId,
        teamDomain,
        lastError: null,
      });
    } catch (error) {
      const parsed = tunnelErrorFrom(error);
      const message = sanitizeAccessMessage(parsed.message);
      await this.accessStore.save({ lastError: message }).catch(() => {});
      throw new TunnelError('access_api_failed', message);
    }
  }

  private async clearAccessCredentials(): Promise<void> {
    await this.accessStore.save({
      apiToken: null,
      accountId: null,
      lastError: null,
    });
  }

  private async setAccessEnforce(
    enforceJwt: boolean,
    acknowledgeExposure?: boolean
  ): Promise<void> {
    const access = this.accessStore.get();
    if (!access.appId || !access.aud) {
      throw new TunnelError('not_configured', 'Cloudflare Access is not configured');
    }
    if (!enforceJwt) {
      await this.requireLastProtectionAck(acknowledgeExposure);
    }
    await this.accessStore.save({ enforceJwt, lastError: null });
  }

  private resolveAccessHostname(explicit?: string, forSync = false): string {
    const persisted = this.store.get();
    return resolveAccessHostname({
      explicit,
      mode: persisted.mode,
      tunnelHostname: persisted.hostname,
      externalHostname: this.lastExternal.hostnames[0],
      forSync,
    });
  }

  private async jobConfigureAccess(
    rulesRaw: unknown,
    step: (name: string) => void,
    hostnameRaw?: string
  ): Promise<void> {
    const rules = parseAccessRules(rulesRaw);
    const hostname = this.resolveAccessHostname(hostnameRaw);
    const apiToken = await this.accessStore.getApiToken();
    const accountId = this.accessStore.get().accountId;
    if (!apiToken || !accountId) {
      throw new TunnelError('not_configured', 'Cloudflare Access credentials are not saved');
    }
    try {
      step('create_app');
      const current = this.accessStore.get();
      const app = current.appId
        ? await this.accessClient.updateApp(accountId, apiToken, current.appId, hostname)
        : await this.accessClient.createApp(accountId, apiToken, hostname);
      step('policy');
      await this.accessClient.replaceAllowPolicy(accountId, apiToken, app.id, rules);
      let bypassAppIds: string[] = [];
      if (this.hasMeshRole) {
        step('bypass_app');
        bypassAppIds = await this.accessClient.upsertBypassApps(
          accountId,
          apiToken,
          hostname,
          current.bypassAppIds
        );
      }
      step('verify');
      const verified = await this.accessClient.getApp(accountId, apiToken, app.id);
      const verifiedPolicies = await this.accessClient.listPolicies(
        accountId,
        apiToken,
        verified.id
      );
      const allow = verifiedPolicies.find((p) => p.name === 'tmex-allow' && p.decision === 'allow');
      if (!allow) {
        throw new TunnelError(
          'access_api_failed',
          'Cloudflare Access did not persist the tmex-allow policy'
        );
      }
      await this.accessStore.save({
        appId: verified.id,
        aud: verified.aud,
        hostname,
        rules,
        enforceJwt: true,
        bypassAppIds,
        lastError: null,
      });
    } catch (error) {
      const parsed = tunnelErrorFrom(error);
      const message = sanitizeAccessMessage(parsed.message);
      await this.accessStore.save({ lastError: message }).catch(() => {});
      throw new TunnelError(
        parsed.code === 'access_api_failed' ? 'access_api_failed' : parsed.code,
        message
      );
    }
  }

  private async jobRemoveAccess(step: (name: string) => void): Promise<void> {
    step('delete_app');
    const row = this.accessStore.get();
    const apiToken = await this.accessStore.getApiToken();
    if (row.appId && apiToken && row.accountId) {
      await this.accessClient.deleteApp(row.accountId, apiToken, row.appId);
    }
    if (apiToken && row.accountId) {
      for (const id of row.bypassAppIds) {
        await this.accessClient.deleteApp(row.accountId, apiToken, id);
      }
    }
    await this.accessStore.save({
      appId: null,
      aud: null,
      hostname: null,
      rules: [],
      enforceJwt: false,
      bypassAppIds: [],
      lastError: null,
    });
  }

  private async jobSyncAccess(step: (name: string) => void, hostnameRaw?: string): Promise<void> {
    step('sync');
    const apiToken = await this.accessStore.getApiToken();
    const accountId = this.accessStore.get().accountId;
    if (!apiToken || !accountId) {
      throw new TunnelError('not_configured', 'Cloudflare Access credentials are not saved');
    }
    await this.refreshExternal({ force: true });
    const hostname = this.resolveAccessHostname(hostnameRaw, true);
    try {
      const apps = await this.accessClient.listApps(accountId, apiToken);
      if (apps.truncated)
        throw new TunnelError('access_api_failed', 'Access app list is incomplete');
      const app = this.accessClient.findAppForHostname(apps, hostname);
      if (!app) {
        await this.accessStore.save({
          lastError: sanitizeAccessMessage('No Access application matches this hostname'),
        });
        return;
      }
      const rules = await this.accessClient.readAppRules(accountId, apiToken, app.id);
      const bypass = this.accessClient.findBypassApps(apps, hostname);
      await this.accessStore.save({
        appId: app.id,
        aud: app.aud,
        hostname,
        rules,
        bypassAppIds: bypass.map((a) => a.id),
        lastError: null,
      });
    } catch (error) {
      const parsed = tunnelErrorFrom(error);
      const message = sanitizeAccessMessage(parsed.message);
      await this.accessStore.save({ lastError: message }).catch(() => {});
      throw new TunnelError('access_api_failed', message);
    }
  }

  private async adoptExternal(hostnameRaw: string): Promise<void> {
    const hostname = normalizeTunnelHostname(hostnameRaw);
    if (!hostname) {
      throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
    }
    this.externalDetector.invalidate();
    await this.refreshExternal({ force: true });
    if (!this.lastExternal.hostnames.includes(hostname)) {
      throw new TunnelError('invalid_request', 'hostname is not in the detected external tunnel');
    }
    this.store.save({
      mode: 'named',
      hostname,
      tunnelId: this.lastExternal.tunnelId,
      tunnelName: this.lastExternal.tunnelName,
      externallyManaged: true,
      autoStart: false,
    });
  }

  private async refreshConfiguredTrustProxy(): Promise<void> {
    if (this.readHostEnv) {
      const saved = await this.readHostEnv();
      this.configuredTrustProxy = saved ?? this.trustProxy;
    }
    this.restartRequired = this.configuredTrustProxy !== this.trustProxy;
  }

  private async startProcess(mode: TunnelMode): Promise<void> {
    if (mode === 'off') {
      throw new TunnelError('not_configured', 'tunnel is not configured');
    }
    const bin = this.requireBinary();
    this.resetConnector();
    this.edgeRecovery.reset();
    if (this.isManagedProcessActive()) {
      await this.supervisor.stop();
    }
    this.lastStartOpts = {
      bin,
      mode,
      originUrl: this.originUrl,
      configPath: configYmlPath(this.tunnelDir),
    };
    this.logs.clear();
    this.supervisor.publicUrl = null;
    await this.supervisor.start(this.lastStartOpts);
    this.lastEdge = this.supervisor.edge;
    try {
      await this.waitUntilRunning();
    } finally {
      // 起不来（fake-IP 下永远 0 连接）也要开轮询，否则边缘自愈永远不会被触发
      await this.probeAndStoreConnector().catch(() => {});
      this.connectorPoll.sync();
    }
  }

  private processState(persisted: TunnelPersisted): TunnelProcessState {
    return tunnelProcessState({
      persisted,
      externalRunning: this.lastExternal.running,
      connector: this.lastConnector,
      supervisorState: this.supervisor.state,
    });
  }

  private statusLog(): string[] {
    const persisted = this.safePersisted();
    const path = persisted.externallyManaged ? this.lastExternal.logFile : null;
    if (!path) return this.logs.snapshot();
    const now = this.now();
    const cache = this.logTailCache;
    if (cache && cache.path === path && now - cache.at < 2_000) return cache.lines;
    void this.refreshExternalLogTail();
    return cache?.path === path ? cache.lines : [];
  }

  private async refreshExternalLogTail(): Promise<void> {
    const path = this.lastExternal.logFile;
    if (!path) {
      this.logTailCache = null;
      return;
    }
    const now = this.now();
    const cache = this.logTailCache;
    if (cache && cache.path === path && now - cache.at < 2_000) return;
    try {
      const lines = await readLogTail(path, { maxBytes: 64 * 1024, maxLines: 200 });
      this.logTailCache = { at: this.now(), path, lines };
    } catch {
      this.logTailCache = { at: this.now(), path, lines: [] };
    }
  }

  private shouldProbeConnector(): boolean {
    const persisted = this.safePersisted();
    if (persisted.externallyManaged) return this.lastExternal.running;
    // 进程活着就该探：注册超时后 state 会停在 starting / error，但 cloudflared 仍在跑
    return this.isManagedProcessActive() || this.supervisor.state === 'starting';
  }

  private isConnectorStale(): boolean {
    if (!this.shouldProbeConnector()) return false;
    if (!this.lastConnector.checkedAt) return true;
    if (this.connectorPollMs <= 0) return false;
    const at = Date.parse(this.lastConnector.checkedAt);
    if (!Number.isFinite(at)) return true;
    return this.now() - at >= this.connectorPollMs;
  }

  private resetConnector(): void {
    this.connectorPoll.stop();
    this.connectorProbeInFlight = null;
    this.lastConnector = { ...EMPTY_CONNECTOR };
  }

  private connectorHint(connector: TunnelConnectorStatus = this.lastConnector): string {
    return connectorHintText(connector, () => edgeHintText(this.currentEdge()));
  }

  private currentEdge(): TunnelEdgeResolution | null {
    const edge = this.supervisor.edge;
    if (edge) this.lastEdge = edge;
    return this.lastEdge ? { ...this.lastEdge } : null;
  }

  private resetEdge(): void {
    this.lastEdge = null;
    this.edgeRecovery.reset();
  }

  private async restartWithEdge(
    edge: TunnelEdgeResolution,
    token: EdgeRecoveryToken
  ): Promise<void> {
    const opts = this.lastStartOpts;
    if (!opts || token.cancelled) return;
    this.lastEdge = edge;
    await this.supervisor.stop();
    // 停旧进程期间用户可能已手动停止 / 重启：作废的自愈不得把隧道再开回来
    if (token.cancelled || this.lastStartOpts !== opts) return;
    await this.supervisor.start(opts, edge);
  }

  private async connectorLogLines(): Promise<string[]> {
    if (this.safePersisted().externallyManaged && this.lastExternal.logFile) {
      await this.refreshExternalLogTail();
      return this.logTailCache?.lines ?? [];
    }
    return this.logs.snapshot();
  }

  async probeAndStoreConnector(): Promise<TunnelConnectorStatus> {
    if (this.connectorProbeInFlight) return this.connectorProbeInFlight;
    const run = this.runConnectorProbe();
    this.connectorProbeInFlight = run;
    try {
      return await run;
    } finally {
      if (this.connectorProbeInFlight === run) this.connectorProbeInFlight = null;
    }
  }

  private async runConnectorProbe(): Promise<TunnelConnectorStatus> {
    const gen = this.connectorPoll.generation;
    const pid = this.supervisor.pid;
    const startedAt = this.supervisor.startedAt;
    const commit = (next: TunnelConnectorStatus): TunnelConnectorStatus => {
      if (gen !== this.connectorPoll.generation) return this.lastConnector;
      if (pid !== this.supervisor.pid || startedAt !== this.supervisor.startedAt) {
        return this.lastConnector;
      }
      this.lastConnector = next;
      return next;
    };
    try {
      const logLines = await this.connectorLogLines();
      const addrs = discoverMetricsAddr({
        spawnedAddr: this.supervisor.metricsAddr,
        argvAddr: this.lastExternal.metricsAddr,
        configAddr: this.lastExternal.metricsAddr,
        logLines,
        includeDefaults: this.scanDefaultMetrics,
      });
      const probed = await probeConnector(addrs, this.fetchImpl, {
        timeoutMs: 1_500,
        now: this.now,
      });
      const lastError = probed.lastError ?? extractLastError(logLines);
      return commit({
        ...probed,
        lastError: lastError ? redactSecrets(lastError) : null,
        checkedAt: new Date(this.now()).toISOString(),
      });
    } catch {
      const logLines = await this.connectorLogLines().catch(() => [] as string[]);
      const lastError = extractLastError(logLines);
      return commit({
        ...EMPTY_CONNECTOR,
        lastError: lastError ? redactSecrets(lastError) : null,
        checkedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  private async waitUntilRunning(): Promise<void> {
    const deadline = this.now() + this.runningWaitMs;
    while (this.now() < deadline) {
      if (processUp(this.supervisor.state)) return;
      if (this.supervisor.state === 'error' && !this.supervisor.runningEnabled) {
        throw new TunnelError(
          'process_failed',
          this.supervisor.lastError ?? 'cloudflared failed to start'
        );
      }
      await Bun.sleep(5);
    }
    if (!processUp(this.supervisor.state)) {
      throw new TunnelError('process_failed', 'cloudflared did not register a connection in time');
    }
  }

  private safePersisted(): TunnelPersisted {
    try {
      return this.store.get();
    } catch {
      return { ...DEFAULT_TUNNEL_CONFIG };
    }
  }
}

export const tunnelManager = new TunnelManager();
