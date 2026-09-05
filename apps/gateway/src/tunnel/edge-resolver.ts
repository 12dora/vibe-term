import { promises as dnsPromises } from 'node:dns';
import { errorMessage } from '@tmex/shared';
import type { TunnelEdgeResolution } from '@tmex/shared';

export const EDGE_SRV_NAME = '_v2-origintunneld._tcp.argotunnel.com';
export const WELL_KNOWN_EDGE_HOSTS = [
  'region1.v2.argotunnel.com',
  'region2.v2.argotunnel.com',
] as const;
export const DEFAULT_EDGE_PORT = 7844;
export const EDGE_ADDRS_ENV = 'TMEX_TUNNEL_EDGE_ADDRS';
export const MAX_EDGE_ADDRS = 8;
export const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
] as const;

const DOH_REQUEST_TIMEOUT_MS = 5_000;
const DOH_TOTAL_BUDGET_MS = 10_000;
const DOH_RETRY_ATTEMPTS = 3;
const DOH_RETRY_SPACING_MS = 1_500;
/** 重试期整体预算：首轮沿用 10 s，另给后两次重试 5 s（含间隔），启动最多多等 5 s。 */
const DOH_RETRY_TOTAL_BUDGET_MS = DOH_TOTAL_BUDGET_MS + 5_000;
/** 缓存的静态边缘可用期：Cloudflare 边缘 IP 数周不变，过期才判定不可用。 */
export const LAST_STATIC_EDGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DNS_TYPE_A = 1;
const DNS_TYPE_SRV = 33;
const MAX_ERROR_LEN = 160;

export type EdgeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type EdgeLookup = (hostname: string) => Promise<string[]>;

/** 静态边缘的来源：环境变量覆盖 / 本次 DoH 解析 / 上次成功结果的持久化缓存。 */
export type EdgeSource = 'env' | 'doh' | 'cache';

export type CachedEdge = { edgeAddrs: string[]; resolvedAt: string };

export type EdgeCache = {
  read: () => Promise<CachedEdge | null>;
  write: (value: CachedEdge) => Promise<void>;
};

export type EdgeResolution = TunnelEdgeResolution & { source?: EdgeSource };

export interface ResolveEdgeOptions {
  fetchImpl: EdgeFetch;
  lookup?: EdgeLookup;
  now?: () => number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  cache?: EdgeCache;
  sleep?: (ms: number) => Promise<void>;
}

const OCTET_RE = /^\d{1,3}$/;

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!OCTET_RE.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** 198.18.0.0/15：RFC 2544 基准测试段，本机代理（Surge 等）常用作 fake-IP */
export function isFakeIp(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return false;
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

/** [首字节, 次字节下界, 次字节上界]：本地/私有/保留段，不能当 edge 地址用 */
const UNUSABLE_V4_BLOCKS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 255],
  [10, 0, 255],
  [127, 0, 255],
  [100, 64, 127],
  [169, 254, 254],
  [172, 16, 31],
  [192, 168, 168],
];

export function isUnusableEdgeIp(ip: string): boolean {
  const octets = ipv4Octets(ip);
  if (!octets) return true;
  if (isFakeIp(ip)) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a >= 224) return true;
  return UNUSABLE_V4_BLOCKS.some(([first, min, max]) => a === first && b >= min && b <= max);
}

function shortError(error: unknown): string {
  const message = errorMessage(error);
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_ERROR_LEN ? `${trimmed.slice(0, MAX_ERROR_LEN)}…` : trimmed;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const entries = await dnsPromises.lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
}

type ScopedSignal = { signal: AbortSignal; readonly timedOut: boolean; done: () => void };

function requestSignal(outer: AbortSignal | undefined, ms: number): ScopedSignal {
  const controller = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error(`timed out after ${ms}ms`));
  }, ms);
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut(): boolean {
      return state.timedOut;
    },
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/** 端点超时要单独认出来：同一次解析里不再拿剩余预算去撞同一个黑洞。 */
class DohTimeoutError extends Error {}

/**
 * 一次 `resolveEdgeViaDoh` 内的端点状态：记住成功过的端点优先复用，
 * 超时过的端点直接跳过，避免首选端点被黑洞时耗光后续查询的预算。
 */
type DohRunState = { preferred: string | null; timedOut: Set<string> };

function newDohRunState(): DohRunState {
  return { preferred: null, timedOut: new Set() };
}

function endpointOrder(state: DohRunState): string[] {
  const all: string[] = [...DOH_ENDPOINTS];
  const usable = all.filter((endpoint) => !state.timedOut.has(endpoint));
  const list = usable.length > 0 ? usable : all;
  const preferred = state.preferred;
  if (!preferred || !list.includes(preferred)) return list;
  return [preferred, ...list.filter((endpoint) => endpoint !== preferred)];
}

type DohAnswer = { type: number; data: string };

function parseDohAnswers(body: unknown, type: number): string[] {
  if (!body || typeof body !== 'object') return [];
  const rec = body as { Status?: unknown; Answer?: unknown };
  if (typeof rec.Status === 'number' && rec.Status !== 0) {
    throw new Error(`DoH status ${rec.Status}`);
  }
  if (!Array.isArray(rec.Answer)) return [];
  const out: string[] = [];
  for (const item of rec.Answer as DohAnswer[]) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== type || typeof item.data !== 'string') continue;
    out.push(item.data);
  }
  return out;
}

async function dohQuery(
  fetchImpl: EdgeFetch,
  endpoint: string,
  name: string,
  type: number,
  signal: AbortSignal | undefined,
  budgetMs: number,
  requestTimeoutMs: number
): Promise<string[]> {
  const timeout = Math.max(1, Math.min(requestTimeoutMs, budgetMs));
  const scoped = requestSignal(signal, timeout);
  try {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetchImpl(url, {
      headers: { accept: 'application/dns-json' },
      signal: scoped.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDohAnswers(await res.json(), type);
  } catch (error) {
    if (scoped.timedOut) throw new DohTimeoutError(`timed out after ${timeout}ms`);
    throw error;
  } finally {
    scoped.done();
  }
}

type DohQueryCtx = {
  fetchImpl: EdgeFetch;
  signal: AbortSignal | undefined;
  deadline: number;
  now: () => number;
  state: DohRunState;
  requestTimeoutMs: number;
};

async function dohQueryAny(ctx: DohQueryCtx, name: string, type: number): Promise<string[]> {
  let lastError: unknown = new Error('no DoH endpoint attempted');
  for (const endpoint of endpointOrder(ctx.state)) {
    const budget = ctx.deadline - ctx.now();
    if (budget <= 0) break;
    try {
      const answers = await dohQuery(
        ctx.fetchImpl,
        endpoint,
        name,
        type,
        ctx.signal,
        budget,
        ctx.requestTimeoutMs
      );
      ctx.state.preferred = endpoint;
      return answers;
    } catch (error) {
      lastError = error;
      if (error instanceof DohTimeoutError) ctx.state.timedOut.add(endpoint);
    }
  }
  throw new Error(`${name}/${type}: ${shortError(lastError)}`);
}

export type EdgeTarget = { target: string; port: number };

export function parseSrvData(data: string): EdgeTarget | null {
  const parts = data.trim().split(/\s+/);
  if (parts.length < 4) return null;
  const port = Number(parts[2]);
  const target = (parts[3] ?? '').replace(/\.$/, '').toLowerCase();
  if (!target || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { target, port };
}

function wellKnownTargets(): EdgeTarget[] {
  return WELL_KNOWN_EDGE_HOSTS.map((target) => ({ target, port: DEFAULT_EDGE_PORT }));
}

async function resolveSrvTargets(ctx: DohQueryCtx): Promise<EdgeTarget[]> {
  try {
    const answers = await dohQueryAny(ctx, EDGE_SRV_NAME, DNS_TYPE_SRV);
    const targets: EdgeTarget[] = [];
    const seen = new Set<string>();
    for (const answer of answers) {
      const parsed = parseSrvData(answer);
      if (!parsed || seen.has(parsed.target)) continue;
      seen.add(parsed.target);
      targets.push(parsed);
    }
    if (targets.length > 0) return targets;
  } catch {}
  return wellKnownTargets();
}

function interleave(lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let i = 0; i < longest && out.length < MAX_EDGE_ADDRS; i += 1) {
    for (const list of lists) {
      const value = list[i];
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= MAX_EDGE_ADDRS) break;
    }
  }
  return out;
}

/** 用 DoH 绕开本机解析器，拿到 cloudflared 边缘的真实地址；失败抛错，由调用方兜住 */
export async function resolveEdgeViaDoh(
  fetchImpl: EdgeFetch,
  signal?: AbortSignal,
  now: () => number = Date.now,
  opts: { requestTimeoutMs?: number; budgetMs?: number } = {}
): Promise<{ addrs: string[] }> {
  const ctx: DohQueryCtx = {
    fetchImpl,
    signal,
    deadline: now() + (opts.budgetMs ?? DOH_TOTAL_BUDGET_MS),
    now,
    state: newDohRunState(),
    requestTimeoutMs: opts.requestTimeoutMs ?? DOH_REQUEST_TIMEOUT_MS,
  };
  const targets = await resolveSrvTargets(ctx);
  const lists: string[][] = [];
  let lastError: unknown = null;
  for (const target of targets) {
    if (now() >= ctx.deadline) break;
    try {
      const answers = await dohQueryAny(ctx, target.target, DNS_TYPE_A);
      lists.push(
        answers
          .map((ip) => ip.trim())
          .filter((ip) => !isUnusableEdgeIp(ip))
          .map((ip) => `${ip}:${target.port}`)
      );
    } catch (error) {
      lastError = error;
    }
  }
  const addrs = interleave(lists);
  if (addrs.length === 0) {
    throw new Error(lastError ? shortError(lastError) : 'DoH returned no usable edge addresses');
  }
  return { addrs };
}

const HOST_PORT_RE = /^\[?[A-Za-z0-9.:_-]+\]?:\d{1,5}$/;

export function parseEdgeAddrsEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value || seen.has(value) || !HOST_PORT_RE.test(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_EDGE_ADDRS) break;
  }
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * fake-IP 环境下 DoH 常在开机瞬间失败（代理刚起、网络未就绪），重试几次即可成功；
 * 整个重试期共用一个预算，避免把 spawn 卡在黑洞上。
 */
async function resolveEdgeViaDohWithRetry(
  opts: ResolveEdgeOptions,
  now: () => number
): Promise<{ addrs: string[] }> {
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + DOH_RETRY_TOTAL_BUDGET_MS;
  let lastError: unknown = new Error('DoH edge resolution was not attempted');
  for (let attempt = 1; attempt <= DOH_RETRY_ATTEMPTS; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    try {
      return await resolveEdgeViaDoh(opts.fetchImpl, opts.signal, now, {
        budgetMs: Math.min(DOH_TOTAL_BUDGET_MS, remaining),
      });
    } catch (error) {
      lastError = error;
    }
    if (attempt === DOH_RETRY_ATTEMPTS || deadline - now() <= DOH_RETRY_SPACING_MS) break;
    await sleep(DOH_RETRY_SPACING_MS);
  }
  throw lastError;
}

async function readFreshEdgeCache(
  cache: EdgeCache | undefined,
  nowMs: number
): Promise<CachedEdge | null> {
  if (!cache) return null;
  try {
    const value = await cache.read();
    if (!value || value.edgeAddrs.length === 0) return null;
    const at = Date.parse(value.resolvedAt);
    if (!Number.isFinite(at) || nowMs - at > LAST_STATIC_EDGE_MAX_AGE_MS) return null;
    return value;
  } catch {
    return null;
  }
}

async function writeEdgeCache(cache: EdgeCache | undefined, value: CachedEdge): Promise<void> {
  if (!cache) return;
  try {
    await cache.write(value);
  } catch {}
}

/** DoH（含重试）→ 上次成功的静态列表 → 系统解析。永不抛错。 */
async function staticEdgeOrFallback(
  opts: ResolveEdgeOptions,
  now: () => number,
  checkedAt: string
): Promise<EdgeResolution> {
  try {
    const { addrs } = await resolveEdgeViaDohWithRetry(opts, now);
    await writeEdgeCache(opts.cache, {
      edgeAddrs: addrs,
      resolvedAt: new Date(now()).toISOString(),
    });
    return {
      mode: 'static',
      fakeIpDetected: true,
      edgeAddrs: addrs,
      checkedAt,
      lastError: null,
      source: 'doh',
    };
  } catch (error) {
    const lastError = `DoH edge resolution failed: ${shortError(error)}`;
    const cached = await readFreshEdgeCache(opts.cache, now());
    if (cached) {
      return {
        mode: 'static',
        fakeIpDetected: true,
        edgeAddrs: cached.edgeAddrs,
        checkedAt,
        lastError,
        source: 'cache',
      };
    }
    return { mode: 'system', fakeIpDetected: true, edgeAddrs: [], checkedAt, lastError };
  }
}

type SystemLookupResult = { fakeIpDetected: boolean; lookupError: string | null };

async function systemLookup(lookup: EdgeLookup): Promise<SystemLookupResult> {
  const results = await Promise.all(
    WELL_KNOWN_EDGE_HOSTS.map(async (host) => {
      try {
        return { addrs: await lookup(host), error: null as string | null };
      } catch (error) {
        return { addrs: [] as string[], error: shortError(error) };
      }
    })
  );
  const errors = results.map((result) => result.error).filter((e): e is string => Boolean(e));
  return {
    fakeIpDetected: results.some((result) => result.addrs.some((ip) => isFakeIp(ip))),
    lookupError:
      errors.length === results.length && errors.length > 0
        ? `system DNS lookup failed: ${errors[0]}`
        : null,
  };
}

/** 永不抛错：解析失败一律回落到 mode=system，原因写进 lastError */
export async function resolveEdge(opts: ResolveEdgeOptions): Promise<EdgeResolution> {
  const now = opts.now ?? Date.now;
  const checkedAt = new Date(now()).toISOString();
  try {
    const { fakeIpDetected, lookupError } = await systemLookup(opts.lookup ?? defaultLookup);
    const override = parseEdgeAddrsEnv((opts.env ?? process.env)[EDGE_ADDRS_ENV]);
    if (override.length > 0) {
      return {
        mode: 'static',
        fakeIpDetected,
        edgeAddrs: override,
        checkedAt,
        lastError: lookupError,
        source: 'env',
      };
    }
    if (!fakeIpDetected) {
      return {
        mode: 'system',
        fakeIpDetected: false,
        edgeAddrs: [],
        checkedAt,
        lastError: lookupError,
      };
    }
    return await staticEdgeOrFallback(opts, now, checkedAt);
  } catch (error) {
    return {
      mode: 'system',
      fakeIpDetected: false,
      edgeAddrs: [],
      checkedAt,
      lastError: shortError(error),
    };
  }
}

export function describeEdge(edge: EdgeResolution): string {
  return `[tunnel] edge resolution mode=${edge.mode} fakeIp=${edge.fakeIpDetected} addrs=${
    edge.edgeAddrs.length > 0 ? edge.edgeAddrs.join(',') : '-'
  }${edge.source ? ` source=${edge.source}` : ''}${edge.lastError ? ` error=${edge.lastError}` : ''}`;
}
