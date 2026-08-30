import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type {
  TunnelActionRequest,
  TunnelActionResponse,
  TunnelBinaryStatus,
  TunnelErrorResponse,
  TunnelJobKind,
  TunnelJobStatus,
  TunnelMode,
  TunnelStatusResponse,
} from '@tmex/shared';
import { PROCESS_STARTED_AT } from '../api/system-routes';
import { config, originUrlFromBindHost } from '../config';
import { getDb as getOrmDb } from '../db/client';
import {
  DEFAULT_TUNNEL_CONFIG,
  TunnelConfigStore,
  type TunnelConfigStoreLike,
  type TunnelPersisted,
} from './config-store';
import { type Downloader, defaultDownloader, installCloudflaredBinary } from './download';
import { TunnelError, tunnelErrorFrom, tunnelHttpStatus } from './errors';
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
  fetchImpl?: typeof fetch;
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
};

type BinaryCache = {
  path: string | null;
  source: TunnelBinaryStatus['source'];
  version: string | null;
};

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 500;
const HOST_ENV_MESSAGE = 'Host environment is not managed by tmex-cli';
const AUTH_REQUIRED_MESSAGE = 'Sign-in must be enabled before exposing tmex publicly';

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
  private readonly fetchImpl: typeof fetch;
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
    if (persisted.autoStart && persisted.mode !== 'off') {
      if (!this.loginEnforcedFn()) {
        this.warn(`[tunnel] auto-start skipped: ${AUTH_REQUIRED_MESSAGE}`);
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
    const running = this.supervisor.state === 'running';
    const publicUrl =
      persisted.mode === 'named' && running && persisted.hostname
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
        originPort: this.originPort,
      },
      process: {
        state: this.supervisor.state,
        pid: this.supervisor.pid,
        startedAt: this.supervisor.startedAt,
        publicUrl,
        lastError: this.supervisor.lastError,
        restarts: this.supervisor.restarts,
      },
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
          this.requireLoginEnforced();
          this.requireModeOff();
          this.assertCreateName(body.hostname, body.tunnelName);
          return await this.enqueueJob('create', (step) =>
            this.jobCreate(body.hostname, body.tunnelName, step)
          );
        case 'quick_start':
          this.requireLoginEnforced();
          return await this.enqueueJob('start', (step) => this.jobQuickStart(step));
        case 'start':
          this.requireLoginEnforced();
          return await this.enqueueJob('start', (step) => this.jobStart(step));
        case 'stop':
          return await this.enqueueJob('stop', (step) => this.jobStop(step));
        case 'remove':
          return await this.enqueueJob('remove', (step) => this.jobRemove(step));
        case 'check':
          return await this.enqueueJob('check', (step) => this.jobCheck(step));
        case 'set_auto_start':
          if (body.autoStart) this.requireLoginEnforced();
          this.store.save({ autoStart: body.autoStart });
          return this.ok(200);
        case 'set_trust_proxy':
          await this.setTrustProxy(body.trustProxy);
          return this.ok(200);
        default:
          throw new TunnelError('invalid_request', 'unknown action');
      }
    } catch (error) {
      const parsed = tunnelErrorFrom(error);
      return {
        httpStatus: tunnelHttpStatus(parsed.code),
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

  private requireLoginEnforced(): void {
    if (!this.loginEnforcedFn()) {
      throw new TunnelError('auth_required', AUTH_REQUIRED_MESSAGE);
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
