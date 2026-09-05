import type { TunnelEdgeResolution, TunnelProcessState } from '@tmex/shared';
import { extractLastError } from './connector-health';
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
const UNREGISTERED_RE = /Unregistered tunnel connection/i;
const TERMINATED_RE = /Connection terminated/i;

function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseConnIndex(line: string): number | null {
  const rec = tryParseJsonLine(line);
  if (rec && typeof rec.connIndex === 'number' && Number.isFinite(rec.connIndex)) {
    return rec.connIndex;
  }
  const match = line.match(/connIndex[=:\s]+(\d+)/i);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

export class TunnelSupervisor {
  state: TunnelProcessState = 'stopped';
  pid: number | null = null;
  startedAt: string | null = null;
  publicUrl: string | null = null;
  lastError: string | null = null;
  restarts = 0;
  metricsAddr: string | null = null;
  edge: TunnelEdgeResolution | null = null;

  private readonly edgeConnIndexes = new Set<number>();
  private child: SpawnHandle | null = null;
  /** 自愈拿到的静态边缘地址：本次 enabled 期间（含崩溃重启）都沿用，stop 时清掉。 */
  private edgeOverride: TunnelEdgeResolution | null = null;
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

  get edgeConnections(): number {
    return this.edgeConnIndexes.size;
  }

  async start(
    opts: {
      bin: string;
      mode: SupervisorMode;
      originUrl: string;
      configPath: string;
    },
    edgeOverride: TunnelEdgeResolution | null = null
  ): Promise<void> {
    this.enabled = true;
    this.edgeOverride = edgeOverride;
    this.generation += 1;
    this.lastError = null;
    this.publicUrl = null;
    this.backoffMs = MIN_BACKOFF_MS;
    await this.spawnChild(opts, this.generation);
  }

  async stop(): Promise<void> {
    this.enabled = false;
    this.edgeOverride = null;
    this.generation += 1;
    const child = this.child;
    this.child = null;
    this.publicUrl = null;
    this.metricsAddr = null;
    this.edge = null;
    this.edgeConnIndexes.clear();
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
      originUrl: string;
      configPath: string;
    },
    generation: number
  ): Promise<void> {
    if (!this.enabled || generation !== this.generation) return;
    this.state = 'starting';
    this.publicUrl = null;
    this.edgeConnIndexes.clear();
    const child =
      opts.mode === 'named'
        ? await this.deps.provider.spawnNamedRun(opts.bin, opts.configPath, this.edgeOverride)
        : await this.deps.provider.spawnQuickRun(opts.bin, opts.originUrl, this.edgeOverride);
    this.child = child;
    this.pid = child.pid;
    this.startedAt = new Date().toISOString();
    this.metricsAddr = child.metricsAddr ?? null;
    this.edge = child.edge ?? null;

    const onLine = (line: string): void => {
      this.handleLine(line);
    };

    void consumeLines(child.stdout, onLine);
    void consumeLines(child.stderr, onLine);

    void child.exited.then((code) => {
      void this.onExit(code, opts, generation);
    });
  }

  private handleLine(line: string): void {
    this.deps.logs.push(line);
    const err = extractLastError([line]);
    if (err) this.lastError = err;

    const quickUrl = parseQuickUrl(line);
    if (quickUrl) {
      this.publicUrl = quickUrl;
      this.deps.onPublicUrl?.(quickUrl);
      if (this.state === 'starting') this.state = 'running';
    }

    if (UNREGISTERED_RE.test(line) || TERMINATED_RE.test(line)) {
      const connIndex = parseConnIndex(line);
      if (connIndex != null) this.edgeConnIndexes.delete(connIndex);
      else this.edgeConnIndexes.clear();
      if (this.state === 'running' && this.edgeConnIndexes.size === 0) {
        this.state = 'degraded';
      }
      return;
    }

    if (isRegisteredLine(line)) {
      const connIndex = parseConnIndex(line);
      this.edgeConnIndexes.add(connIndex ?? 0);
      if (this.state === 'starting' || this.state === 'degraded') {
        this.state = 'running';
        this.backoffMs = MIN_BACKOFF_MS;
      }
    }
  }

  private async onExit(
    code: number,
    opts: {
      bin: string;
      mode: SupervisorMode;
      originUrl: string;
      configPath: string;
    },
    generation: number
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.child = null;
    this.pid = null;
    this.metricsAddr = null;
    this.edgeConnIndexes.clear();
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
