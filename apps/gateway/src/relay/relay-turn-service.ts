import { BUILTIN_STUN_SERVERS } from '@vibeterm/shared/net';
import type { AuthDb } from '../auth/types';
import type { StunProbeDeps } from '../mesh/rtc/stun-probe';
import type { StunResolveOptions } from '../mesh/rtc/stun-resolver';
import {
  DEFAULT_TURN_RELAY_PORT_RANGE,
  EMPTY_RELAY_TURN_STATUS,
  type RelayTurnAdvertisement,
  type RelayTurnStatus,
  TURN_BIND_RETRY_MAX_MS,
  TURN_BIND_RETRY_MIN_MS,
  TURN_REALM,
  TURN_REFRESH_INTERVAL_MS,
  type TurnPortRange,
  type TurnSource,
  advertisedTurnHost,
  bindErrorMessage,
  decideTurnMode,
  describeTurnPortConflict,
  externalTurnFromConfig,
  formatTurnPortRange,
  isRetryableBindError,
  parsePortFromTurnUrl,
  turnResolveHost,
} from './relay-turn-config';
import { type TurnLongTermCredential, loadOrCreateTurnCredentials } from './relay-turn-credentials';
import {
  type TurnHostResolver,
  type TurnStunProbe,
  resolveTurnExternalIp,
} from './relay-turn-resolve';
import { type TurnServer, createTurnServer, turnUrlFor } from './turn';
import { clampTurnAllocations } from './turn/turn-limits';
import type { RelayRuntimeConfig } from './types';

export type RelayTurnServiceLog = (line: string) => void;

export type RelayTurnServiceOptions = {
  db: AuthDb;
  config: RelayRuntimeConfig;
  log?: RelayTurnServiceLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createServer?: typeof createTurnServer;
  resolveHost?: TurnHostResolver;
  probeStun?: TurnStunProbe;
  stunServers?: readonly string[];
  resolveOpts?: StunResolveOptions;
  probeDeps?: StunProbeDeps;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  refreshIntervalMs?: number;
  onAdvertisementChange?: () => void;
};

const PREFIX = '[relay][turn]';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class RelayTurnService {
  private readonly db: AuthDb;
  private readonly config: RelayRuntimeConfig;
  private readonly logLine: RelayTurnServiceLog;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createServer: typeof createTurnServer;
  private readonly resolveHost: TurnHostResolver | undefined;
  private readonly probeStun: TurnStunProbe | undefined;
  private readonly stunServers: readonly string[];
  private readonly resolveOpts: StunResolveOptions | undefined;
  private readonly probeDeps: StunProbeDeps | undefined;
  private readonly setIntervalFn: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (id: ReturnType<typeof setInterval>) => void;
  private readonly refreshIntervalMs: number;
  private onAdvertisementChange: (() => void) | undefined;
  private source: TurnSource;
  private error: string | null = null;
  private advertised: RelayTurnAdvertisement = null;
  private creds: TurnLongTermCredential | null = null;
  private server: TurnServer | null = null;
  private host: string | null = null;
  private externalIp: string | null = null;
  private listenPort: number | null = null;
  private relayRange: TurnPortRange | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private retrying = false;
  private stopped = false;

  constructor(opts: RelayTurnServiceOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.logLine = opts.log ?? ((line) => console.log(line));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.createServer = opts.createServer ?? createTurnServer;
    this.resolveHost = opts.resolveHost;
    this.probeStun = opts.probeStun;
    this.stunServers = opts.stunServers ?? BUILTIN_STUN_SERVERS;
    this.resolveOpts = opts.resolveOpts;
    this.probeDeps = opts.probeDeps;
    this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((id) => clearInterval(id));
    this.refreshIntervalMs = opts.refreshIntervalMs ?? TURN_REFRESH_INTERVAL_MS;
    this.onAdvertisementChange = opts.onAdvertisementChange;
    this.source = decideTurnMode(opts.config);
  }

  setOnAdvertisementChange(cb: (() => void) | undefined): void {
    this.onAdvertisementChange = cb;
  }

  advertisement(): RelayTurnAdvertisement {
    return this.advertised;
  }

  status(): RelayTurnStatus {
    if (this.source === 'off') {
      return {
        ...EMPTY_RELAY_TURN_STATUS,
        port: this.config.turnPort === 0 ? 0 : null,
        error: this.error,
      };
    }
    if (this.source === 'external') {
      const turn = this.advertised;
      return {
        enabled: turn != null,
        source: 'external',
        url: turn?.url ?? null,
        port: turn?.url ? parsePortFromTurnUrl(turn.url) : null,
        externalIp: null,
        listening: false,
        allocations: 0,
        error: this.error,
        relayPortRange: null,
      };
    }
    const snap = this.server?.snapshot();
    const listening = snap?.listening === true;
    return {
      enabled: listening,
      source: 'builtin',
      url: this.advertised?.url ?? null,
      port: snap?.port ?? this.listenPort,
      externalIp: snap?.externalIp ?? this.externalIp,
      bindHost: snap?.bindHost ?? null,
      listening,
      allocations: snap?.allocations ?? 0,
      error: this.error,
      relayPortRange: this.relayRange ? formatTurnPortRange(this.relayRange) : null,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.source === 'off') {
      this.logDisabled('port disabled');
      return;
    }
    if (this.source === 'external') {
      this.advertised = externalTurnFromConfig(this.config);
      return;
    }
    await this.startBuiltin();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.retrying = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.refreshTimer) {
      this.clearIntervalFn(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this.advertised = this.source === 'external' ? externalTurnFromConfig(this.config) : null;
  }

  private log(line: string): void {
    this.logLine(line.startsWith(PREFIX) ? line : `${PREFIX} ${line}`);
  }

  private logDisabled(reason: string): void {
    this.log(`builtin turn disabled reason=${reason}`);
  }

  private logListening(): void {
    const range = this.relayRange;
    const maxAlloc = range ? clampTurnAllocations(range).maxAllocations : '-';
    this.log(
      `builtin turn listening port=${this.listenPort ?? '-'} bind=${this.server?.snapshot().bindHost ?? '-'} external_ip=${this.externalIp ?? '-'} host=${this.host ?? '-'} relay_range=${range ? formatTurnPortRange(range) : '-'} max_alloc=${maxAlloc}`
    );
  }

  private logAllocations(): void {
    this.log(`turn allocations=${this.server?.snapshot().allocations ?? 0}`);
  }

  private publish(next: RelayTurnAdvertisement): void {
    const prev = this.advertised?.url ?? null;
    this.advertised = next;
    const url = next?.url ?? null;
    if (url !== prev) this.onAdvertisementChange?.();
  }

  private async startBuiltin(): Promise<void> {
    const listenPort = this.config.turnPort ?? 0;
    const relayRange = this.config.turnRelayPortRange ?? DEFAULT_TURN_RELAY_PORT_RANGE;
    this.listenPort = listenPort;
    this.relayRange = relayRange;
    const conflict = describeTurnPortConflict(
      listenPort,
      relayRange,
      this.config.rtcPortRange,
      this.config.peerPort
    );
    if (conflict) {
      this.error = conflict;
      this.logDisabled(conflict);
      return;
    }
    this.creds = loadOrCreateTurnCredentials(this.db);
    const resolved = await this.resolveIp();
    if (!resolved.ip) {
      this.error = resolved.error ?? 'external ip unknown';
      this.logDisabled(this.error);
      this.armRefresh();
      return;
    }
    this.applyExternalIp(resolved.ip);
    this.applyAdvertisedHost();
    const bound = await this.tryStartServer();
    if (bound) {
      this.armRefresh();
      return;
    }
    if (this.retrying) this.armRefresh();
  }

  private async resolveIp(): Promise<{ ip: string | null; error: string | null }> {
    return resolveTurnExternalIp({
      overrideIp: this.config.turnExternalIp,
      advertisedHost: turnResolveHost(this.config.publicUrl, this.config.turnHost),
      resolveHost: this.resolveHost,
      probeStun: this.probeStun,
      stunServers: this.stunServers,
      resolveOpts: this.resolveOpts,
      probeDeps: this.probeDeps,
    });
  }

  private async tryStartServer(): Promise<boolean> {
    if (
      this.stopped ||
      !this.creds ||
      !this.externalIp ||
      this.listenPort == null ||
      !this.relayRange
    ) {
      return false;
    }
    const creds = this.creds;
    const server = this.createServer({
      listenHost: this.config.turnBindHost ?? 'auto',
      listenPort: this.listenPort,
      relayPortRange: this.relayRange,
      externalIp: this.externalIp,
      realm: TURN_REALM,
      credentials: (username) => (username === creds.username ? creds.credential : null),
      log: (line) => this.log(line),
      now: this.now,
    });
    try {
      const { port } = await server.start();
      this.server = server;
      this.listenPort = port;
      this.error = null;
      this.retrying = false;
      this.logListening();
      this.reAdvertise();
      return true;
    } catch (err) {
      await server.stop().catch(() => undefined);
      this.server = null;
      this.error = bindErrorMessage(err);
      if (isRetryableBindError(err)) {
        this.logDisabled(`EADDRINUSE port=${this.listenPort}`);
        this.scheduleRetry();
        return false;
      }
      this.logDisabled(this.error);
      return false;
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retrying) return;
    this.retrying = true;
    void this.retryLoop();
  }

  private async retryLoop(): Promise<void> {
    let delay = TURN_BIND_RETRY_MIN_MS;
    while (!this.stopped && this.retrying) {
      await this.sleep(delay);
      if (this.stopped || !this.retrying) return;
      const bound = await this.tryStartServer();
      if (bound) return;
      delay = Math.min(delay * 2, TURN_BIND_RETRY_MAX_MS);
    }
  }

  private armRefresh(): void {
    if (this.refreshTimer || this.refreshIntervalMs <= 0 || this.stopped) return;
    const timer = this.setIntervalFn(() => {
      void this.refresh();
    }, this.refreshIntervalMs);
    timer.unref?.();
    this.refreshTimer = timer;
  }

  private applyExternalIp(ip: string): boolean {
    if (ip === this.externalIp) return false;
    this.externalIp = ip;
    this.server?.setExternalIp(ip);
    return true;
  }

  private applyAdvertisedHost(): boolean {
    if (!this.externalIp) return false;
    const next = advertisedTurnHost(this.config.turnHost, this.externalIp);
    if (next === this.host) return false;
    this.host = next;
    return true;
  }

  private reAdvertise(): void {
    if (this.listenPort == null || !this.creds || !this.host) return;
    this.publish({
      url: turnUrlFor(this.host, this.listenPort),
      username: this.creds.username,
      credential: this.creds.credential,
    });
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.source !== 'builtin') return;
    this.logAllocations();
    const resolved = await this.resolveIp();
    if (!resolved.ip) return;
    const ipChanged = this.applyExternalIp(resolved.ip);
    const hostChanged = this.applyAdvertisedHost();
    if (!this.server) {
      await this.tryStartServer();
      return;
    }
    if (ipChanged || hostChanged) this.reAdvertise();
  }
}

export function createRelayTurnService(opts: RelayTurnServiceOptions): RelayTurnService {
  return new RelayTurnService(opts);
}
