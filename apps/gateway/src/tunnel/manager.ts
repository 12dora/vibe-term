import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type {
  TunnelAccessStatus,
  TunnelActionRequest,
  TunnelActionResponse,
  TunnelBinaryStatus,
  TunnelErrorResponse,
  TunnelExternalStatus,
  TunnelJobKind,
  TunnelJobStatus,
  TunnelMode,
  TunnelStatusResponse,
} from '@tmex/shared';
import { PROCESS_STARTED_AT } from '../api/system-routes';
import { config, originUrlFromBindHost } from '../config';
import { getDb as getOrmDb } from '../db/client';
import { CloudflareAccessClient, type TunnelFetch, sanitizeAccessMessage } from './access-client';
import { setAccessGuardSource, setAccessJwtVerifier } from './access-guard';
import { AccessJwtVerifier } from './access-jwt';
import { parseAccessRules } from './access-rules';
import {
  MemoryTunnelAccessStore,
  TunnelAccessStore,
  type TunnelAccessStoreLike,
} from './access-store';
import {
  DEFAULT_TUNNEL_CONFIG,
  TunnelConfigStore,
  type TunnelConfigStoreLike,
  type TunnelPersisted,
} from './config-store';
import { type Downloader, defaultDownloader, installCloudflaredBinary } from './download';
import { TunnelError, tunnelErrorFrom, tunnelHttpStatus } from './errors';
import {
  type ExternalDetectDeps,
  type ExternalDetection,
  ExternalTunnelDetector,
} from './external-detect';
import { defaultTunnelName, normalizeTunnelHostname, normalizeTunnelName } from './hostname';
import { LogRingBuffer } from './log-buffer';
import { isTunnelPlatformSupported, tunnelPlatformLabel } from './platform';
import {
  CloudflaredProvider,
  configYmlPath,
  credentialsPathFor,
  managedBinaryPath,
  originCertPath,
  parseLoginUrl,
} from './provider';
import { type Spawner, bunSpawner, consumeLines } from './spawn';
import { TunnelSupervisor } from './supervisor';

export type PatchHostEnv = (trustProxy: boolean) => Promise<void>;
export type ReadHostEnv = () => Promise<boolean | null>;

export type TunnelManagerOptions = {
  tunnelDir?: string;
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
};

type BinaryCache = {
  path: string | null;
  source: TunnelBinaryStatus['source'];
  version: string | null;
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 500;
const HOST_ENV_MESSAGE = 'Host environment is not managed by tmex-cli';
const EXPOSURE_ACK_MESSAGE =
  'This instance has no sign-in and no Cloudflare Access protection; confirm public exposure explicitly';
const EXTERNAL_MANAGED_MESSAGE = 'managed by the system service';

const EMPTY_EXTERNAL: ExternalDetection = {
  detected: false,
  source: null,
  configPath: null,
  tunnelId: null,
  tunnelName: null,
  hostnames: [],
  hasOriginCert: false,
  running: false,
  pid: null,
  tokenFile: null,
  logFile: null,
  accountId: null,
  tokenAccountId: null,
};

function yamlQuote(value: string): string {
  if (/[:#\n]|^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export function writeNamedConfigYml(opts: {
  tunnelId: string;
  credentialsPath: string;
  certPath: string;
  hostname: string;
  originUrl: string;
}): string {
  return [
    `tunnel: ${opts.tunnelId}`,
    `credentials-file: ${yamlQuote(opts.credentialsPath)}`,
    `origincert: ${yamlQuote(opts.certPath)}`,
    'ingress:',
    `  - hostname: ${opts.hostname}`,
    `    service: ${opts.originUrl}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

export class TunnelManager {
  private readonly tunnelDir: string;
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
  private lastExternal: ExternalDetection = { ...EMPTY_EXTERNAL };
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
    this.loginEnforcedFn = opts.loginEnforced ?? (() => config.roles.hub || config.roles.node);
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
        getCredentials: async () => {
          const apiToken = await this.accessStore.getApiToken();
          const accountId = this.accessStore.get().accountId;
          if (!apiToken || !accountId) return null;
          return { accountId, apiToken };
        },
        accessClient: this.accessClient,
        ...opts.externalDetectDeps,
      });
    if (opts.registerAccessGuard !== false) {
      setAccessGuardSource(() => this.accessGuardState());
      setAccessJwtVerifier(this.jwtVerifier);
    }
    const spawner: Spawner = opts.spawner ?? bunSpawner;
    this.provider = new CloudflaredProvider(spawner, this.tunnelDir);
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
    await this.refreshExternal();
    if (persisted.autoStart && persisted.mode !== 'off') {
      if (persisted.externallyManaged) {
        // 系统服务托管，不拉起子进程
      } else if (!this.isExposureProtected() && !persisted.exposureAcknowledgedAt) {
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
    await this.supervisor.stop();
  }

  status(): TunnelStatusResponse {
    this.refreshBinaryPresence();
    const persisted = this.safePersisted();
    const loggedIn = existsSync(originCertPath(this.tunnelDir));
    const access = this.accessStatus();
    const external = this.externalStatus();
    const loginEnforced = this.loginEnforcedFn();
    const exposureProtected = this.isExposureProtected(persisted, access, loginEnforced);
    const running = persisted.externallyManaged
      ? this.lastExternal.running
      : this.supervisor.state === 'running';
    const publicUrl = persisted.externallyManaged
      ? persisted.hostname
        ? `https://${persisted.hostname}`
        : null
      : persisted.mode === 'named' && running && persisted.hostname
        ? `https://${persisted.hostname}`
        : persisted.mode === 'quick' && running
          ? this.supervisor.publicUrl
          : null;
    return {
      supported: isTunnelPlatformSupported(this.platform, this.arch),
      platform: tunnelPlatformLabel(this.platform, this.arch),
      binary: {
        installed: Boolean(this.binary.path),
        version: this.binary.version,
        path: this.binary.path,
        source: this.binary.source,
      },
      auth: {
        loggedIn,
        loginUrl: this.job?.kind === 'login' && this.job.state === 'running' ? this.loginUrl : null,
      },
      config: {
        mode: persisted.mode,
        hostname: persisted.hostname,
        tunnelName: persisted.tunnelName,
        tunnelId: persisted.tunnelId,
        autoStart: persisted.autoStart,
        externallyManaged: persisted.externallyManaged,
        originPort: this.originPort,
      },
      process: {
        state: persisted.externallyManaged
          ? this.lastExternal.running
            ? 'running'
            : 'stopped'
          : this.supervisor.state,
        pid: persisted.externallyManaged ? null : this.supervisor.pid,
        startedAt: persisted.externallyManaged ? null : this.supervisor.startedAt,
        publicUrl,
        lastError: persisted.externallyManaged ? null : this.supervisor.lastError,
        restarts: persisted.externallyManaged ? 0 : this.supervisor.restarts,
      },
      access,
      external,
      loginEnforced,
      exposureProtected,
      job: this.job ? { ...this.job } : null,
      trustProxy: this.trustProxy,
      configuredTrustProxy: this.configuredTrustProxy,
      restartRequired: this.restartRequired,
      log: this.logs.snapshot(),
    };
  }

  async handleAction(
    body: TunnelActionRequest
  ): Promise<{ httpStatus: number; payload: TunnelActionResponse | TunnelErrorResponse }> {
    try {
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
        case 'set_access_credentials':
          await this.setAccessCredentials(body.apiToken, body.accountId);
          return this.ok(200);
        case 'clear_access_credentials':
          await this.clearAccessCredentials();
          return this.ok(200);
        case 'configure_access':
          return await this.enqueueJob('access', (step) =>
            this.jobConfigureAccess(body.rules, step)
          );
        case 'remove_access':
          return await this.enqueueJob('access', (step) => this.jobRemoveAccess(step));
        case 'sync_access':
          return await this.enqueueJob('access', (step) => this.jobSyncAccess(step));
        case 'set_access_enforce':
          await this.setAccessEnforce(body.enforceJwt);
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
    return (
      loginEnforced ||
      Boolean(
        access.configured &&
          access.enforceJwt &&
          access.hostname &&
          access.hostname === persisted.hostname
      )
    );
  }

  private accessGuardState() {
    const access = this.accessStatus();
    return {
      configured: access.configured,
      enforceJwt: access.enforceJwt,
      aud: access.aud,
      teamDomain: access.teamDomain,
    };
  }

  private accessStatus(): TunnelAccessStatus {
    try {
      const row = this.accessStore.get();
      return {
        hasCredentials: Boolean(row.apiTokenEnc && row.accountId),
        accountId: row.accountId,
        teamDomain: row.teamDomain,
        configured: Boolean(row.appId && row.aud && row.hostname),
        appId: row.appId,
        aud: row.aud,
        hostname: row.hostname,
        rules: [...row.rules],
        enforceJwt: row.enforceJwt,
        lastError: row.lastError,
      };
    } catch {
      return {
        hasCredentials: false,
        accountId: null,
        teamDomain: null,
        configured: false,
        appId: null,
        aud: null,
        hostname: null,
        rules: [],
        enforceJwt: false,
        lastError: null,
      };
    }
  }

  private externalStatus(): TunnelExternalStatus {
    const ext = this.lastExternal;
    return {
      detected: ext.detected,
      source: ext.source,
      configPath: ext.configPath,
      tunnelId: ext.tunnelId,
      tunnelName: ext.tunnelName,
      hostnames: [...ext.hostnames],
      hasOriginCert: ext.hasOriginCert,
      running: ext.running,
    };
  }

  async refreshExternal(): Promise<void> {
    try {
      this.lastExternal = await this.externalDetector.detect();
    } catch {
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
    if (!existsSync(originCertPath(this.tunnelDir))) {
      throw new TunnelError('not_logged_in', 'cloudflared is not logged in');
    }
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
    const cert = originCertPath(this.tunnelDir);
    if (existsSync(cert)) {
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
      if (existsSync(cert)) {
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
      if (exited !== null && !existsSync(cert)) {
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
    const url = `${target.replace(/\/$/, '')}/healthz`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);
    try {
      const res = await this.fetchImpl(url, { signal: ac.signal });
      if (!res.ok) {
        throw new TunnelError('unknown', `health check HTTP ${res.status}`);
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
      const message = error instanceof Error ? error.message : String(error);
      throw new TunnelError('unknown', `health check failed: ${message}`);
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

  private async setAccessEnforce(enforceJwt: boolean): Promise<void> {
    const access = this.accessStore.get();
    if (!access.appId || !access.aud) {
      throw new TunnelError('not_configured', 'Cloudflare Access is not configured');
    }
    await this.accessStore.save({ enforceJwt, lastError: null });
  }

  private async jobConfigureAccess(rulesRaw: unknown, step: (name: string) => void): Promise<void> {
    const rules = parseAccessRules(rulesRaw);
    const persisted = this.store.get();
    const hostname = persisted.hostname;
    if (!hostname) {
      throw new TunnelError('not_configured', 'named tunnel hostname is required');
    }
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
      step('verify');
      const verified = await this.accessClient.getApp(accountId, apiToken, app.id);
      await this.accessStore.save({
        appId: verified.id,
        aud: verified.aud,
        hostname,
        rules,
        enforceJwt: true,
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
      await this.accessClient.deleteApp(row.accountId, apiToken, row.appId).catch(() => {});
    }
    await this.accessStore.save({
      appId: null,
      aud: null,
      hostname: null,
      rules: [],
      enforceJwt: false,
      lastError: null,
    });
  }

  private async jobSyncAccess(step: (name: string) => void): Promise<void> {
    step('sync');
    const apiToken = await this.accessStore.getApiToken();
    const accountId = this.accessStore.get().accountId;
    if (!apiToken || !accountId) {
      throw new TunnelError('not_configured', 'Cloudflare Access credentials are not saved');
    }
    await this.refreshExternal();
    const hostname = this.store.get().hostname ?? this.lastExternal.hostnames[0] ?? null;
    if (!hostname) {
      throw new TunnelError('not_configured', 'no hostname to match an Access application');
    }
    try {
      const apps = await this.accessClient.listApps(accountId, apiToken);
      const app = this.accessClient.findAppForHostname(apps, hostname);
      if (!app) {
        await this.accessStore.save({
          lastError: sanitizeAccessMessage('No Access application matches this hostname'),
        });
        return;
      }
      const rules = await this.accessClient.readAppRules(accountId, apiToken, app.id);
      await this.accessStore.save({
        appId: app.id,
        aud: app.aud,
        hostname,
        rules,
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
    await this.refreshExternal();
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
    if (
      this.supervisor.runningEnabled ||
      this.supervisor.state === 'running' ||
      this.supervisor.state === 'starting'
    ) {
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
    await this.waitUntilRunning();
  }

  private async waitUntilRunning(): Promise<void> {
    const deadline = this.now() + this.runningWaitMs;
    while (this.now() < deadline) {
      if (this.supervisor.state === 'running') return;
      if (this.supervisor.state === 'error' && !this.supervisor.runningEnabled) {
        throw new TunnelError(
          'process_failed',
          this.supervisor.lastError ?? 'cloudflared failed to start'
        );
      }
      await Bun.sleep(5);
    }
    if (this.supervisor.state !== 'running') {
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
