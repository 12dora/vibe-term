export type RelayProbeState = 'ok' | 'bad' | 'unknown';

export const RELAY_PROBE_OK_TTL_MS = 10 * 60_000;
export const RELAY_PROBE_BAD_TTL_MS = 2 * 60_000;
export const RELAY_PROBE_TIMEOUT_MS = 5_000;

export type RelayProbeFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RelayEntryProbeOptions = {
  localNodeId: () => string | null;
  fetch?: RelayProbeFetch;
  now?: () => number;
  timeoutMs?: number;
  okTtlMs?: number;
  badTtlMs?: number;
};

type CacheEntry = { state: 'ok' | 'bad'; expiresAt: number };

function probeKey(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 中继入口可达性探测：只有同时担任 `node` 角色的中继主机才转发 `/n/<nodeId>/*`，
 * 纯中继主机的 HTTP 面只有 `/relay/uplink` 与 `/api/relay/*`，浏览器打不开分享。
 * 因此中继候选必须先探到 `${url}/n/${localNodeId}/api/auth/mode` 返回本机 nodeId 才允许产出。
 */
export class RelayEntryProbe {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly fetchImpl: RelayProbeFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly okTtlMs: number;
  private readonly badTtlMs: number;

  constructor(private readonly options: RelayEntryProbeOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? RELAY_PROBE_TIMEOUT_MS;
    this.okTtlMs = options.okTtlMs ?? RELAY_PROBE_OK_TTL_MS;
    this.badTtlMs = options.badTtlMs ?? RELAY_PROBE_BAD_TTL_MS;
  }

  state(url: string): RelayProbeState {
    const key = probeKey(url);
    const entry = this.cache.get(key);
    if (!entry) return 'unknown';
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return 'unknown';
    }
    return entry.state;
  }

  /** 丢弃某地址的缓存结论：上联刚接上中继时，接上之前的 `bad` 不该继续挡住候选。 */
  invalidate(url: string): void {
    this.cache.delete(probeKey(url));
  }

  /** 发即忘：缓存有效或已有在途探测时不重复发起，结果落在下一次 `state()`。 */
  ensure(url: string): void {
    const key = probeKey(url);
    if (!key) return;
    if (this.state(url) !== 'unknown') return;
    if (this.inflight.has(key)) return;
    const nodeId = this.options.localNodeId();
    if (!nodeId) return;
    const task = this.probe(key, nodeId).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
  }

  /** 测试用：等所有在途探测结束。 */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight.values()]);
    }
  }

  private async probe(key: string, nodeId: string): Promise<void> {
    const ok = await this.checkEntry(key, nodeId);
    this.cache.set(key, {
      state: ok ? 'ok' : 'bad',
      expiresAt: this.now() + (ok ? this.okTtlMs : this.badTtlMs),
    });
  }

  private async checkEntry(key: string, nodeId: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${key}/n/${nodeId}/api/auth/mode`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status !== 200) return false;
      const body = (await res.json()) as { nodeId?: unknown } | null;
      return typeof body?.nodeId === 'string' && body.nodeId === nodeId;
    } catch {
      return false;
    }
  }
}
