import type { TunnelProcessState } from '@tmex/shared';
import type { LogRingBuffer } from './log-buffer';
import { type CloudflaredProvider, isRegisteredLine, parseQuickUrl } from './provider';
import { type SpawnHandle, consumeLines } from './spawn';

export type SupervisorMode = 'named' | 'quick';

export interface SupervisorDeps {
  provider: CloudflaredProvider;
  logs: LogRingBuffer;
  sleep: (ms: number) => Promise<void>;
  killTimeoutMs: number;
  onPublicUrl?: (url: string) => void;
  maxBackoffMs?: number;
}

const MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class TunnelSupervisor {
  state: TunnelProcessState = 'stopped';
  pid: number | null = null;
  startedAt: string | null = null;
  publicUrl: string | null = null;
  lastError: string | null = null;
  restarts = 0;

  private child: SpawnHandle | null = null;
  private enabled = false;
  private generation = 0;
  private backoffMs = MIN_BACKOFF_MS;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBackoffMs: number;

  constructor(private readonly deps: SupervisorDeps) {
    this.maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  get runningEnabled(): boolean {
    return this.enabled;
  }

  async start(opts: {
    bin: string;
    mode: SupervisorMode;
    originPort: number;
    configPath: string;
    namedPublicUrl: string | null;
  }): Promise<void> {
    this.enabled = true;
    this.generation += 1;
    this.lastError = null;
    this.backoffMs = MIN_BACKOFF_MS;
    await this.spawnChild(opts, this.generation);
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.generation += 1;
    const child = this.child;
    this.child = null;
    if (!child) {
      this.state = 'stopped';
      this.pid = null;
      this.startedAt = null;
      return;
    }
    await this.terminate(child);
    this.state = 'stopped';
    this.pid = null;
  }

  private async spawnChild(
    opts: {
      bin: string;
      mode: SupervisorMode;
      originPort: number;
      configPath: string;
      namedPublicUrl: string | null;
    },
    generation: number
  ): Promise<void> {
    if (!this.enabled || generation !== this.generation) return;
    this.state = 'starting';
    this.publicUrl = opts.mode === 'named' ? opts.namedPublicUrl : this.publicUrl;
    const child =
      opts.mode === 'named'
        ? this.deps.provider.spawnNamedRun(opts.bin, opts.configPath)
        : this.deps.provider.spawnQuickRun(opts.bin, opts.originPort);
    this.child = child;
    this.pid = child.pid;
    this.startedAt = new Date().toISOString();

    const onLine = (line: string): void => {
      this.deps.logs.push(line);
      const quickUrl = parseQuickUrl(line);
      if (quickUrl) {
        this.publicUrl = quickUrl;
        this.deps.onPublicUrl?.(quickUrl);
        if (this.state === 'starting') this.state = 'running';
      }
      if (isRegisteredLine(line) && this.state === 'starting') {
        this.state = 'running';
        this.backoffMs = MIN_BACKOFF_MS;
      }
    };

    void consumeLines(child.stdout, onLine);
    void consumeLines(child.stderr, onLine);

    void child.exited.then((code) => {
      void this.onExit(code, opts, generation);
    });
  }

  private async onExit(
    code: number,
    opts: {
      bin: string;
      mode: SupervisorMode;
      originPort: number;
      configPath: string;
      namedPublicUrl: string | null;
    },
    generation: number
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.child = null;
    this.pid = null;
    if (!this.enabled) {
      this.state = 'stopped';
      return;
    }
    this.lastError = `cloudflared exited with code ${code}`;
    this.state = 'starting';
    this.restarts += 1;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
    await this.deps.sleep(wait);
    if (!this.enabled || generation !== this.generation) return;
    await this.spawnChild(opts, generation);
  }

  private async terminate(child: SpawnHandle): Promise<void> {
    let settled = false;
    const done = child.exited.then(() => {
      settled = true;
    });
    child.kill('SIGTERM');
    const timeout = new Promise<void>((resolve) => {
      this.killTimer = setTimeout(resolve, this.deps.killTimeoutMs);
    });
    await Promise.race([done, timeout]);
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (!settled) {
      child.kill('SIGKILL');
      await child.exited.catch(() => {});
    }
  }
}
