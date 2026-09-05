import { promises as dnsPromises } from 'node:dns';
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
const DNS_TYPE_A = 1;
const DNS_TYPE_SRV = 33;
const MAX_ERROR_LEN = 160;

export type EdgeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type EdgeLookup = (hostname: string) => Promise<string[]>;

export interface ResolveEdgeOptions {
  fetchImpl: EdgeFetch;
  lookup?: EdgeLookup;
  now?: () => number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
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
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_ERROR_LEN ? `${trimmed.slice(0, MAX_ERROR_LEN)}…` : trimmed;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const entries = await dnsPromises.lookup(hostname, { all: true });
  return entries.map((entry) => entry.address);
}

function requestSignal(
  outer: AbortSignal | undefined,
  ms: number
): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
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
  budgetMs: number
): Promise<string[]> {
  const timeout = Math.max(1, Math.min(DOH_REQUEST_TIMEOUT_MS, budgetMs));
  const scoped = requestSignal(signal, timeout);
  try {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetchImpl(url, {
      headers: { accept: 'application/dns-json' },
      signal: scoped.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseDohAnswers(await res.json(), type);
  } finally {
    scoped.done();
  }
}

async function dohQueryAny(
  fetchImpl: EdgeFetch,
  name: string,
  type: number,
  signal: AbortSignal | undefined,
  deadline: number,
  now: () => number
): Promise<string[]> {
  let lastError: unknown = new Error('no DoH endpoint attempted');
  for (const endpoint of DOH_ENDPOINTS) {
    const budget = deadline - now();
    if (budget <= 0) break;
    try {
      return await dohQuery(fetchImpl, endpoint, name, type, signal, budget);
    } catch (error) {
      lastError = error;
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

async function resolveSrvTargets(
  fetchImpl: EdgeFetch,
  signal: AbortSignal | undefined,
  deadline: number,
  now: () => number
): Promise<EdgeTarget[]> {
  try {
    const answers = await dohQueryAny(
      fetchImpl,
      EDGE_SRV_NAME,
      DNS_TYPE_SRV,
      signal,
      deadline,
      now
    );
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
  now: () => number = Date.now
): Promise<{ addrs: string[] }> {
  const deadline = now() + DOH_TOTAL_BUDGET_MS;
  const targets = await resolveSrvTargets(fetchImpl, signal, deadline, now);
  const lists: string[][] = [];
  let lastError: unknown = null;
  for (const target of targets) {
    if (now() >= deadline) break;
    try {
      const answers = await dohQueryAny(
        fetchImpl,
        target.target,
        DNS_TYPE_A,
        signal,
        deadline,
        now
      );
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

/** 永不抛错：解析失败一律回落到 mode=system，原因写进 lastError */
export async function resolveEdge(opts: ResolveEdgeOptions): Promise<TunnelEdgeResolution> {
  const now = opts.now ?? Date.now;
  const lookup = opts.lookup ?? defaultLookup;
  const checkedAt = new Date(now()).toISOString();
  try {
    const results = await Promise.all(
      WELL_KNOWN_EDGE_HOSTS.map(async (host) => {
        try {
          return { addrs: await lookup(host), error: null as string | null };
        } catch (error) {
          return { addrs: [] as string[], error: shortError(error) };
        }
      })
    );
    const fakeIpDetected = results.some((result) => result.addrs.some((ip) => isFakeIp(ip)));
    const errors = results.map((result) => result.error).filter((e): e is string => Boolean(e));
    const lookupError =
      errors.length === results.length && errors.length > 0
        ? `system DNS lookup failed: ${errors[0]}`
        : null;

    const override = parseEdgeAddrsEnv((opts.env ?? process.env)[EDGE_ADDRS_ENV]);
    if (override.length > 0) {
      return {
        mode: 'static',
        fakeIpDetected,
        edgeAddrs: override,
        checkedAt,
        lastError: lookupError,
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
    try {
      const { addrs } = await resolveEdgeViaDoh(opts.fetchImpl, opts.signal, now);
      return { mode: 'static', fakeIpDetected: true, edgeAddrs: addrs, checkedAt, lastError: null };
    } catch (error) {
      return {
        mode: 'system',
        fakeIpDetected: true,
        edgeAddrs: [],
        checkedAt,
        lastError: `DoH edge resolution failed: ${shortError(error)}`,
      };
    }
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

export function describeEdge(edge: TunnelEdgeResolution): string {
  return `[tunnel] edge resolution mode=${edge.mode} fakeIp=${edge.fakeIpDetected} addrs=${
    edge.edgeAddrs.length > 0 ? edge.edgeAddrs.join(',') : '-'
  }${edge.lastError ? ` error=${edge.lastError}` : ''}`;
}
