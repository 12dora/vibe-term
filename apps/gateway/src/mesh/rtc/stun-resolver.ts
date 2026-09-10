import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { errorMessage } from '@vibeterm/shared';
import { logAt } from '../../log/level';
import {
  type DohResolveOptions,
  isFakeIp,
  resolveHostnameViaDoh,
} from '../../tunnel/edge-resolver';
import { stamp } from '../mesh-log';
import type { IceServer } from './native';

export const STUN_RESOLVE_CACHE_TTL_MS = 10 * 60 * 1_000;
export const STUN_RESOLVE_NEGATIVE_TTL_MS = 60 * 1_000;
export const STUN_RESOLVE_CACHE_MAX = 32;
export const STUN_RESOLVE_BUDGET_MS = 2_000;
export const STUN_RESOLVE_LOG_INTERVAL_MS = 10 * 60 * 1_000;
export const STUN_RESOLVE_SNAPSHOT_MAX = 8;

const ICE_SCHEME_RE = /^(stuns?|turns?):/i;
const RTC_STUN_PREFIX = '[mesh][rtc]';

export type StunLookup = (hostname: string) => Promise<string[]>;
export type StunDoh = (hostname: string, opts: DohResolveOptions) => Promise<string[]>;

export type StunResolveOptions = {
  lookup?: StunLookup;
  doh?: StunDoh;
  fetchImpl?: DohResolveOptions['fetchImpl'];
  now?: () => number;
  budgetMs?: number;
  signal?: AbortSignal;
};

export type StunResolveVia = 'system' | 'doh';

export type StunResolveRecord = {
  host: string;
  ip: string | null;
  via: StunResolveVia;
  fakeIp: boolean;
  ms: number;
};

type CacheEntry = {
  ip: string | null;
  via: StunResolveVia;
  fakeIp: boolean;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StunResolveRecord>>();
const lastLogAt = new Map<string, number>();
const snapshot: StunResolveRecord[] = [];

export function resetStunResolverForTest(): void {
  cache.clear();
  inflight.clear();
  lastLogAt.clear();
  snapshot.length = 0;
}

/** gather 侧诊断钩子：最近几次 STUN/TURN 主机名解析结果。 */
export function stunResolveSnapshot(): readonly StunResolveRecord[] {
  return snapshot;
}

export function formatHostForIceUrl(ip: string): string {
  return isIP(ip) === 6 ? `[${ip}]` : ip;
}

export function stripHostBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function defaultLookup(hostname: string): Promise<string[]> {
  return dnsPromises
    .lookup(hostname, { all: true })
    .then((entries) => entries.map((entry) => entry.address));
}

export type SplitIceServerUrl = {
  scheme: string;
  host: string;
  portPart: string;
  query: string;
};

export function splitIceServerUrl(url: string): SplitIceServerUrl | null {
  const trimmed = url.trim();
  const schemeMatch = ICE_SCHEME_RE.exec(trimmed);
  if (!schemeMatch?.[0]) return null;
  const scheme = schemeMatch[0];
  const rest = trimmed.slice(scheme.length);
  const q = rest.indexOf('?');
  const hostport = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q) : '';
  const { host, portPart } = splitHostAndPort(hostport);
  if (!host) return null;
  return { scheme, host, portPart, query };
}

function splitHostAndPort(hostport: string): { host: string; portPart: string } {
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']');
    if (end < 0) return { host: hostport, portPart: '' };
    return { host: hostport.slice(1, end), portPart: hostport.slice(end + 1) };
  }
  const colon = hostport.lastIndexOf(':');
  if (colon > 0 && hostport.indexOf(':') === colon) {
    return { host: hostport.slice(0, colon), portPart: hostport.slice(colon) };
  }
  return { host: hostport, portPart: '' };
}

function isIpLiteral(host: string): boolean {
  return isIP(stripHostBrackets(host)) !== 0;
}

function pickUsableIp(ips: readonly string[]): { ip: string | null; sawFake: boolean } {
  const trimmed = ips.map((ip) => ip.trim()).filter((ip) => ip.length > 0);
  const usable = trimmed.filter((ip) => isIP(ip) !== 0 && !isFakeIp(ip));
  const chosen = usable.find((ip) => isIP(ip) === 4) ?? usable[0] ?? null;
  return { ip: chosen, sawFake: trimmed.some((ip) => isFakeIp(ip)) };
}

function raceDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
  fallback: T
): Promise<T> {
  const ms = deadline - now();
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

function cacheGet(host: string, nowMs: number): CacheEntry | null {
  const hit = cache.get(host);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs) {
    cache.delete(host);
    return null;
  }
  cache.delete(host);
  cache.set(host, hit);
  return hit;
}

function cacheSet(host: string, entry: CacheEntry): void {
  cache.delete(host);
  cache.set(host, entry);
  while (cache.size > STUN_RESOLVE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function rememberSnapshot(record: StunResolveRecord): void {
  snapshot.push(record);
  if (snapshot.length > STUN_RESOLVE_SNAPSHOT_MAX) snapshot.shift();
}

function logResolve(record: StunResolveRecord, failed: boolean, error?: string): void {
  const wall = Date.now();
  const prev = lastLogAt.get(record.host) ?? 0;
  if (prev > 0 && wall - prev < STUN_RESOLVE_LOG_INTERVAL_MS) return;
  lastLogAt.set(record.host, wall);
  const bits = [
    `host=${record.host}`,
    `ip=${record.ip ?? '-'}`,
    `via=${record.via}`,
    `fake_ip=${record.fakeIp ? 'true' : 'false'}`,
    `ms=${record.ms}`,
  ];
  if (error) bits.push(`error=${error}`);
  logAt(failed ? 'warn' : 'info', stamp(`${RTC_STUN_PREFIX} stun resolve ${bits.join(' ')}`));
}

async function lookupAddresses(hostname: string, lookup: StunLookup): Promise<string[]> {
  try {
    return await lookup(hostname);
  } catch {
    return [];
  }
}

function canUseDoh(opts: StunResolveOptions): boolean {
  if (opts.doh || opts.fetchImpl) return true;
  return process.env.NODE_ENV !== 'test';
}

async function dohAddresses(
  hostname: string,
  opts: StunResolveOptions,
  budgetMs: number,
  signal: AbortSignal | undefined
): Promise<string[]> {
  const doh = opts.doh ?? resolveHostnameViaDoh;
  try {
    return await doh(hostname, {
      fetchImpl: opts.fetchImpl,
      signal,
      now: opts.now,
      budgetMs,
      requestTimeoutMs: Math.min(1_000, Math.max(1, budgetMs)),
    });
  } catch {
    return [];
  }
}

async function resolveHostnameUncached(
  hostname: string,
  opts: StunResolveOptions,
  startedAt: number,
  deadline: number
): Promise<StunResolveRecord> {
  const now = opts.now ?? Date.now;
  if (deadline - now() <= 0) {
    return { host: hostname, ip: null, via: 'system', fakeIp: false, ms: now() - startedAt };
  }

  const systemIps = await raceDeadline(
    lookupAddresses(hostname, opts.lookup ?? defaultLookup),
    deadline,
    now,
    []
  );
  const systemPick = pickUsableIp(systemIps);
  if (systemPick.ip) {
    return {
      host: hostname,
      ip: systemPick.ip,
      via: 'system',
      fakeIp: false,
      ms: now() - startedAt,
    };
  }
  const fakeIp = systemPick.sawFake;
  if (!canUseDoh(opts)) {
    return { host: hostname, ip: null, via: 'system', fakeIp, ms: now() - startedAt };
  }

  const budget = deadline - now();
  if (budget <= 0) {
    return { host: hostname, ip: null, via: 'doh', fakeIp, ms: now() - startedAt };
  }
  const dohIps = await raceDeadline(
    dohAddresses(hostname, opts, budget, opts.signal),
    deadline,
    now,
    []
  );
  const dohPick = pickUsableIp(dohIps);
  return { host: hostname, ip: dohPick.ip, via: 'doh', fakeIp, ms: now() - startedAt };
}

async function resolveHostname(
  hostname: string,
  opts: StunResolveOptions,
  deadline: number
): Promise<StunResolveRecord> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const cached = cacheGet(hostname, startedAt);
  if (cached) {
    return {
      host: hostname,
      ip: cached.ip,
      via: cached.via,
      fakeIp: cached.fakeIp,
      ms: 0,
    };
  }
  const pending = inflight.get(hostname);
  if (pending) return pending;

  const work = resolveHostnameUncached(hostname, opts, startedAt, deadline).then((record) => {
    const ttl = record.ip ? STUN_RESOLVE_CACHE_TTL_MS : STUN_RESOLVE_NEGATIVE_TTL_MS;
    cacheSet(hostname, {
      ip: record.ip,
      via: record.via,
      fakeIp: record.fakeIp,
      expiresAt: (opts.now ?? Date.now)() + ttl,
    });
    rememberSnapshot(record);
    if (record.ip) logResolve(record, false);
    else if (record.via === 'doh') logResolve(record, true, 'doh failed');
    return record;
  });
  inflight.set(hostname, work);
  try {
    return await work;
  } finally {
    inflight.delete(hostname);
  }
}

function rewriteUrl(parsed: SplitIceServerUrl, ip: string): string {
  return `${parsed.scheme}${formatHostForIceUrl(ip)}${parsed.portPart}${parsed.query}`;
}

function collectHostnames(servers: ReadonlyArray<string | IceServer>): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const server of servers) {
    const host = hostnameOf(server);
    if (!host || isIpLiteral(host) || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

function hostnameOf(server: string | IceServer): string | null {
  if (typeof server !== 'string') {
    const host = server.hostname.trim();
    return host.length > 0 ? stripHostBrackets(host) : null;
  }
  return splitIceServerUrl(server)?.host ?? null;
}

function applyResolved(
  server: string | IceServer,
  byHost: ReadonlyMap<string, StunResolveRecord>
): string | IceServer {
  if (typeof server === 'string') {
    const parsed = splitIceServerUrl(server);
    if (!parsed || isIpLiteral(parsed.host)) return server;
    const ip = byHost.get(parsed.host)?.ip;
    return ip ? rewriteUrl(parsed, ip) : server;
  }
  const host = stripHostBrackets(server.hostname.trim());
  if (!host || isIpLiteral(host)) return server;
  const ip = byHost.get(host)?.ip;
  if (!ip) return server;
  return { ...server, hostname: ip };
}

async function resolveAllHosts(
  hosts: readonly string[],
  opts: StunResolveOptions,
  deadline: number
): Promise<Map<string, StunResolveRecord>> {
  const records = await Promise.all(hosts.map((host) => resolveHostname(host, opts, deadline)));
  return new Map(records.map((record) => [record.host, record]));
}

/** 把 STUN/TURN URL 里的主机名换成真实 IP；失败时原样返回，不比今天更差。 */
export async function resolveIceServers(
  servers: ReadonlyArray<string | IceServer>,
  opts: StunResolveOptions = {}
): Promise<Array<string | IceServer>> {
  const hosts = collectHostnames(servers);
  if (hosts.length === 0) return [...servers];
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? STUN_RESOLVE_BUDGET_MS);
  try {
    const byHost = await resolveAllHosts(hosts, opts, deadline);
    return servers.map((server) => applyResolved(server, byHost));
  } catch (error) {
    logAt(
      'warn',
      stamp(
        `${RTC_STUN_PREFIX} stun resolve host=* ip=- via=doh fake_ip=false ms=0 error=${errorMessage(error)}`
      )
    );
    return [...servers];
  }
}
