import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { logAt } from '../../log/level';
import {
  type DohResolveOptions,
  isFakeIp,
  isUnusableEdgeIp,
  resolveHostnameViaDoh,
} from '../../tunnel/edge-resolver';
import { stamp } from '../mesh-log';
import type { IceServer } from './native';

export const STUN_RESOLVE_CACHE_TTL_MS = 10 * 60 * 1_000;
export const STUN_RESOLVE_NEGATIVE_TTL_MS = 60 * 1_000;
export const STUN_RESOLVE_NEGATIVE_TTL_MID_MS = 5 * 60 * 1_000;
export const STUN_RESOLVE_NEGATIVE_TTL_MAX_MS = 10 * 60 * 1_000;
export const STUN_RESOLVE_CACHE_MAX = 32;
/** 后台 lookup + DoH 的总预算。 */
export const STUN_RESOLVE_BUDGET_MS = 2_000;
/** 冷缓存时 dial 最多等待；超时返回上次/原始 URL，解析在后台继续。 */
export const STUN_RESOLVE_WAIT_MS = 300;
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
  failCount: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StunResolveRecord>>();
const lastLogAt = new Map<string, number>();
const snapshot: StunResolveRecord[] = [];
let generation = 0;

export function resetStunResolverForTest(opts?: { retainLogTimes?: boolean }): void {
  generation += 1;
  cache.clear();
  inflight.clear();
  snapshot.length = 0;
  if (!opts?.retainLogTimes) lastLogAt.clear();
}

/** 最近几次 STUN/TURN 主机名解析结果的拷贝；目前无调用方。 */
export function stunResolveSnapshot(): readonly StunResolveRecord[] {
  return snapshot.slice();
}

export function formatHostForIceUrl(ip: string): string {
  return isIP(ip) === 6 ? `[${ip}]` : ip;
}

export function stripHostBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function hostKey(host: string): string {
  return stripHostBrackets(host).trim().toLowerCase();
}

function isTlsScheme(scheme: string): boolean {
  const lower = scheme.toLowerCase();
  return lower === 'turns:' || lower === 'stuns:';
}

function isTlsIceServer(server: IceServer): boolean {
  return server.relayType === 'TurnTls';
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

/** isUnusableEdgeIp 把所有非 IPv4（含 AAAA）都判不可用；STUN 仍接受公网 IPv6。 */
function isUsableStunIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 6) return true;
  if (family !== 4) return false;
  return !isUnusableEdgeIp(ip);
}

function pickUsableIp(ips: readonly string[]): { ip: string | null; sawFake: boolean } {
  const trimmed = ips.map((ip) => ip.trim()).filter((ip) => ip.length > 0);
  const usable = trimmed.filter((ip) => isUsableStunIp(ip));
  return { ip: usable[0] ?? null, sawFake: trimmed.some((ip) => isFakeIp(ip)) };
}

function negativeTtlMs(failCount: number): number {
  if (failCount <= 1) return STUN_RESOLVE_NEGATIVE_TTL_MS;
  if (failCount === 2) return STUN_RESOLVE_NEGATIVE_TTL_MID_MS;
  return STUN_RESOLVE_NEGATIVE_TTL_MAX_MS;
}

function toRecord(host: string, entry: CacheEntry | null, ms: number): StunResolveRecord {
  if (!entry) return { host, ip: null, via: 'system', fakeIp: false, ms };
  return { host, ip: entry.ip, via: entry.via, fakeIp: entry.fakeIp, ms };
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
  if (hit.expiresAt <= nowMs) return null;
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
    lastLogAt.delete(oldest);
  }
}

function remember(host: string, record: StunResolveRecord, nowMs: number): void {
  if (record.ip) {
    cacheSet(host, {
      ip: record.ip,
      via: record.via,
      fakeIp: record.fakeIp,
      expiresAt: nowMs + STUN_RESOLVE_CACHE_TTL_MS,
      failCount: 0,
    });
    return;
  }
  const failCount = (cache.get(host)?.failCount ?? 0) + 1;
  cacheSet(host, {
    ip: null,
    via: record.via,
    fakeIp: record.fakeIp,
    expiresAt: nowMs + negativeTtlMs(failCount),
    failCount,
  });
}

function rememberSnapshot(record: StunResolveRecord): void {
  snapshot.push(record);
  if (snapshot.length > STUN_RESOLVE_SNAPSHOT_MAX) snapshot.shift();
}

function logResolve(
  record: StunResolveRecord,
  failed: boolean,
  nowMs: number,
  error?: string
): void {
  const key = hostKey(record.host);
  const prev = lastLogAt.get(key) ?? 0;
  if (prev > 0 && nowMs - prev < STUN_RESOLVE_LOG_INTERVAL_MS) return;
  lastLogAt.set(key, nowMs);
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
      fakeIp: systemPick.sawFake,
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

function commitResolve(
  host: string,
  record: StunResolveRecord,
  gen: number,
  now: () => number
): void {
  if (gen !== generation) return;
  const nowMs = now();
  remember(host, record, nowMs);
  rememberSnapshot(record);
  if (record.ip) logResolve(record, false, nowMs);
  else if (record.via === 'doh') logResolve(record, true, nowMs, 'doh failed');
}

function startResolve(
  hostname: string,
  opts: StunResolveOptions,
  startedAt: number
): Promise<StunResolveRecord> {
  const gen = generation;
  const workDeadline = startedAt + STUN_RESOLVE_BUDGET_MS;
  const work = resolveHostnameUncached(hostname, opts, startedAt, workDeadline).then((record) => {
    commitResolve(hostname, record, gen, opts.now ?? Date.now);
    return record;
  });
  inflight.set(hostname, work);
  void work.finally(() => {
    if (inflight.get(hostname) === work) inflight.delete(hostname);
  });
  return work;
}

async function resolveHostname(
  hostname: string,
  opts: StunResolveOptions,
  waitDeadline: number
): Promise<StunResolveRecord> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const cached = cacheGet(hostname, startedAt);
  if (cached) return toRecord(hostname, cached, 0);

  const stale = cache.get(hostname) ?? null;
  const pending = inflight.get(hostname);
  if (!pending) {
    const work = startResolve(hostname, opts, startedAt);
    if (stale?.ip) return toRecord(hostname, stale, now() - startedAt);
    return raceDeadline(work, waitDeadline, now, toRecord(hostname, stale, now() - startedAt));
  }
  return raceDeadline(pending, waitDeadline, now, toRecord(hostname, stale, now() - startedAt));
}

function rewriteUrl(parsed: SplitIceServerUrl, ip: string): string {
  return `${parsed.scheme}${formatHostForIceUrl(ip)}${parsed.portPart}${parsed.query}`;
}

function collectHostnames(servers: ReadonlyArray<string | IceServer>): string[] {
  const seen = new Set<string>();
  const hosts: string[] = [];
  for (const server of servers) {
    const host = hostnameOf(server);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

function hostnameOf(server: string | IceServer): string | null {
  if (typeof server !== 'string') {
    if (isTlsIceServer(server)) return null;
    const host = hostKey(server.hostname);
    return host.length > 0 && !isIpLiteral(host) ? host : null;
  }
  const parsed = splitIceServerUrl(server);
  if (!parsed || isTlsScheme(parsed.scheme) || isIpLiteral(parsed.host)) return null;
  const host = hostKey(parsed.host);
  return host.length > 0 ? host : null;
}

function shouldSubstitute(record: StunResolveRecord | undefined): string | null {
  if (!record?.ip || record.via !== 'doh') return null;
  return record.ip;
}

function applyResolved(
  server: string | IceServer,
  byHost: ReadonlyMap<string, StunResolveRecord>
): string | IceServer {
  if (typeof server === 'string') {
    const parsed = splitIceServerUrl(server);
    if (!parsed || isTlsScheme(parsed.scheme) || isIpLiteral(parsed.host)) return server;
    const ip = shouldSubstitute(byHost.get(hostKey(parsed.host)));
    return ip ? rewriteUrl(parsed, ip) : server;
  }
  if (isTlsIceServer(server)) return server;
  const host = hostKey(server.hostname);
  if (!host || isIpLiteral(host)) return server;
  const ip = shouldSubstitute(byHost.get(host));
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
  const deadline = now() + (opts.budgetMs ?? STUN_RESOLVE_WAIT_MS);
  const byHost = await resolveAllHosts(hosts, opts, deadline);
  return servers.map((server) => applyResolved(server, byHost));
}
