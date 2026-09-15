/**
 * 上联 / 中继拨号的主机解析：系统 lookup 优先，失败再 DoH。
 * 系统答案若全是 TUN fake-IP（198.18/15），仍先返回该地址（许多主机的 TUN 可用），
 * 由拨号层在 connect 失败后再请求 preferDoh。
 */
import { isIP } from 'node:net';
import {
  type DohResolveOptions,
  isUnusableEdgeIp,
  resolveHostnameViaDoh,
} from '../tunnel/edge-resolver';
import { classifyRemoteAddress, isFakeIpv4, isIpAddressLiteral } from './address-class';
import { logLine, stamp } from './mesh-log';

export const DIAL_DNS_FALLBACK_ENV = 'VIBETERM_DIAL_DNS_FALLBACK';
export const DIAL_SYSTEM_LOOKUP_TIMEOUT_MS = 3_000;
export const DIAL_RESOLVE_TTL_MS = 60_000;
export const DIAL_RESOLVE_NEGATIVE_TTL_MS = 15_000;
export const DIAL_DOH_BUDGET_MS = 5_000;
export const DIAL_RESOLVE_CACHE_MAX = 64;

export type DialResolveVia = 'system' | 'doh';
export type DialResolveResult = { ip: string; via: DialResolveVia; fake?: true };
export type DialLookup = (hostname: string) => Promise<string[]>;
export type DialDoh = (hostname: string, opts?: DohResolveOptions) => Promise<string[]>;

export type ResolveDialHostOptions = {
  lookup?: DialLookup;
  doh?: DialDoh;
  fetchImpl?: DohResolveOptions['fetchImpl'];
  now?: () => number;
  timeoutMs?: number;
  enabled?: boolean;
  dohEnabled?: boolean;
  signal?: AbortSignal;
  /** 系统答案是 fake-IP 且 connect 失败后，跳过系统缓存直接走 DoH。 */
  preferDoh?: boolean;
};

export type DialResolveFn = (
  host: string,
  opts?: Pick<ResolveDialHostOptions, 'signal' | 'preferDoh'>
) => Promise<DialResolveResult | null>;

type CacheEntry = { result: DialResolveResult | null; expiresAt: number; dohFailedUntil?: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DialResolveResult | null>>();
const lastVia = new Map<string, DialResolveVia>();
const lastFailLogAt = new Map<string, number>();
const fakeIpRedialLogged = new Set<string>();

export function resetDialResolveForTest(): void {
  cache.clear();
  inflight.clear();
  lastVia.clear();
  lastFailLogAt.clear();
  fakeIpRedialLogged.clear();
}

export function isDialDnsFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DIAL_DNS_FALLBACK_ENV]?.trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false' && raw !== 'no';
}

export function fallbackOn(override?: boolean): boolean {
  if (override === false) return false;
  if (override === true) return true;
  return isDialDnsFallbackEnabled();
}

export async function resolveDialHost(
  host: string,
  opts: ResolveDialHostOptions = {}
): Promise<DialResolveResult | null> {
  const hostname = stripBrackets(host).trim().toLowerCase();
  if (!hostname) return null;
  if (isIpAddressLiteral(hostname)) return { ip: hostname, via: 'system' };
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const cached = cacheGet(hostname, nowMs);
  if (cached !== undefined && !bypassCached(hostname, opts.preferDoh, cached, nowMs)) return cached;
  const inflightKey = opts.preferDoh ? `${hostname}#doh` : hostname;
  const pending = inflight.get(inflightKey);
  if (pending) return pending;
  const work = resolveUncached(hostname, opts).then((resolved) => {
    const at = now();
    if (opts.preferDoh && resolved.result?.via !== 'doh') {
      markDohFailed(hostname, at);
      if (cached !== undefined) return cached;
    }
    remember(hostname, resolved.result, at);
    noteTransition(hostname, resolved.result, resolved.reason);
    return resolved.result;
  });
  inflight.set(inflightKey, work);
  void work.finally(() => {
    if (inflight.get(inflightKey) === work) inflight.delete(inflightKey);
  });
  return work;
}

export function peekPreferDoh(host: string, nowMs = Date.now()): DialResolveResult | null {
  const hit = cacheGet(host, nowMs);
  return hit?.via === 'doh' ? hit : null;
}

export function forgetPreferDoh(host: string): void {
  const hit = cache.get(host);
  if (hit?.result?.via === 'doh') cache.delete(host);
  fakeIpRedialLogged.delete(host);
}

export function noteFakeIpRedial(host: string, fake: string, real: string, reason: string): void {
  if (fakeIpRedialLogged.has(host)) return;
  fakeIpRedialLogged.add(host);
  logLine(
    '[mesh][dial]',
    `fake-ip redial host=${host} fake=${fake} real=${real} via=doh reason=${reason}`
  );
}

function bypassCached(
  host: string,
  preferDoh: boolean | undefined,
  cached: DialResolveResult | null,
  nowMs: number
): boolean {
  if (!preferDoh) return false;
  if (cached?.via === 'doh') return false;
  return !cacheEntryBlocked(host, nowMs);
}

async function resolveUncached(
  hostname: string,
  opts: ResolveDialHostOptions
): Promise<{ result: DialResolveResult | null; reason?: string }> {
  if (opts.signal?.aborted) return { result: null, reason: 'aborted' };
  const preferred = await preferDohResult(hostname, opts);
  if (preferred) return preferred;
  return await resolveSystemThenDoh(hostname, opts);
}

async function preferDohResult(
  hostname: string,
  opts: ResolveDialHostOptions
): Promise<{ result: DialResolveResult | null; reason?: string } | null> {
  if (!opts.preferDoh) return null;
  if (cacheEntryBlocked(hostname, (opts.now ?? Date.now)())) {
    return { result: null, reason: 'doh negative ttl' };
  }
  const dohHit = await tryDoh(hostname, opts);
  return dohHit.result ? dohHit : null;
}

async function resolveSystemThenDoh(
  hostname: string,
  opts: ResolveDialHostOptions
): Promise<{ result: DialResolveResult | null; reason?: string }> {
  const lookup = opts.lookup ?? defaultLookup;
  const system = pickSystemDialIp(
    await lookupTimed(
      lookup,
      hostname,
      opts.timeoutMs ?? DIAL_SYSTEM_LOOKUP_TIMEOUT_MS,
      opts.signal
    )
  );
  if (system && !opts.preferDoh) return { result: toSystemResult(system) };
  if (opts.signal?.aborted) return { result: null, reason: 'aborted' };
  if (opts.preferDoh) {
    return { result: system ? toSystemResult(system) : null, reason: 'doh empty' };
  }
  if (!canUseDoh(opts)) return { result: null, reason: 'doh disabled' };
  return await tryDoh(hostname, opts);
}

async function tryDoh(
  hostname: string,
  opts: ResolveDialHostOptions
): Promise<{ result: DialResolveResult | null; reason?: string }> {
  if (!canUseDoh(opts)) return { result: null, reason: 'doh disabled' };
  const doh = opts.doh ?? resolveHostnameViaDoh;
  try {
    const dohIp = pickDohDialIp(
      await doh(hostname, {
        fetchImpl: opts.fetchImpl,
        now: opts.now,
        signal: opts.signal,
        budgetMs: DIAL_DOH_BUDGET_MS,
        requestTimeoutMs: 2_000,
      })
    );
    if (!dohIp) return { result: null, reason: 'doh empty' };
    return { result: { ip: dohIp, via: 'doh' } };
  } catch (err) {
    return { result: null, reason: errorMessage(err) || 'doh error' };
  }
}

function toSystemResult(picked: { ip: string; fake?: true }): DialResolveResult {
  return picked.fake
    ? { ip: picked.ip, via: 'system', fake: true }
    : { ip: picked.ip, via: 'system' };
}

function canUseDoh(opts: ResolveDialHostOptions): boolean {
  if (!fallbackOn(opts.enabled)) return false;
  if (opts.dohEnabled !== undefined) return opts.dohEnabled;
  if (opts.doh || opts.fetchImpl) return true;
  return envAllowsDoh();
}

function envAllowsDoh(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'test';
}

/** Bun 默认 fetch/WS 走 c-ares；`backend:'system'` 走 getaddrinfo/NSS，两者可能不一致。 */
async function defaultLookup(hostname: string): Promise<string[]> {
  const entries = await Bun.dns.lookup(hostname, { backend: 'system' });
  return entries.map((entry) => entry.address);
}

async function lookupTimed(
  lookup: DialLookup,
  hostname: string,
  ms: number,
  signal?: AbortSignal
): Promise<string[]> {
  if (signal?.aborted) return [];
  return await new Promise<string[]>((resolve) => {
    let settled = false;
    const finish = (ips: string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ips);
    };
    const timer = setTimeout(() => finish([]), ms);
    const onAbort = (): void => finish([]);
    signal?.addEventListener('abort', onAbort, { once: true });
    lookup(hostname).then(
      (ips) => finish(ips),
      () => finish([])
    );
  });
}

function pickSystemDialIp(ips: readonly string[]): { ip: string; fake?: true } | null {
  const real = pickDohDialIp(ips);
  if (real) return { ip: real };
  const fake = ips.map((ip) => ip.trim()).find((ip) => ip.length > 0 && isFakeIpv4(ip));
  return fake ? { ip: fake, fake: true } : null;
}

function pickDohDialIp(ips: readonly string[]): string | null {
  const usable = ips.map((ip) => ip.trim()).filter((ip) => ip.length > 0 && isUsableDialIp(ip));
  return usable.find((ip) => isIP(ip) === 4) ?? usable[0] ?? null;
}

function isUsableDialIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isUnusableEdgeIp(ip);
  if (family !== 6) return false;
  if (ip === '::') return false;
  return classifyRemoteAddress(ip) !== 'lan';
}

function cacheGet(host: string, nowMs: number): DialResolveResult | null | undefined {
  const hit = cache.get(host);
  if (!hit) return undefined;
  if (hit.expiresAt <= nowMs) {
    cache.delete(host);
    return undefined;
  }
  cache.delete(host);
  cache.set(host, hit);
  return hit.result;
}

function remember(host: string, result: DialResolveResult | null, nowMs: number): void {
  const ttl = result ? DIAL_RESOLVE_TTL_MS : DIAL_RESOLVE_NEGATIVE_TTL_MS;
  const prev = cache.get(host);
  cache.delete(host);
  cache.set(host, {
    result,
    expiresAt: nowMs + ttl,
    dohFailedUntil: result?.via === 'doh' ? undefined : prev?.dohFailedUntil,
  });
  evictOldest();
}

function markDohFailed(host: string, nowMs: number): void {
  const until = nowMs + DIAL_RESOLVE_NEGATIVE_TTL_MS;
  const hit = cache.get(host);
  if (hit) {
    hit.dohFailedUntil = until;
    return;
  }
  cache.set(host, { result: null, expiresAt: until, dohFailedUntil: until });
  evictOldest();
}

function cacheEntryBlocked(host: string, nowMs: number): boolean {
  const hit = cache.get(host);
  return hit != null && hit.dohFailedUntil != null && hit.dohFailedUntil > nowMs;
}

function evictOldest(): void {
  while (cache.size > DIAL_RESOLVE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function noteTransition(host: string, result: DialResolveResult | null, reason?: string): void {
  if (!result) {
    noteFallbackFailure(host, reason ?? 'system and doh failed');
    return;
  }
  lastFailLogAt.delete(host);
  const prev = lastVia.get(host);
  if (result.via === 'doh' && prev !== 'doh') {
    console.warn(stamp(`[uplink] dns fallback host=${host} ip=${result.ip} via=doh`));
  } else if (result.via === 'system' && prev === 'doh') {
    fakeIpRedialLogged.delete(host);
    console.warn(stamp(`[uplink] dns recovered host=${host}`));
  }
  lastVia.set(host, result.via);
}

function noteFallbackFailure(host: string, reason: string): void {
  const nowMs = Date.now();
  const prev = lastFailLogAt.get(host) ?? 0;
  if (nowMs - prev < DIAL_RESOLVE_TTL_MS) return;
  lastFailLogAt.set(host, nowMs);
  console.warn(stamp(`[uplink] dns fallback failed host=${host} reason=${reason}`));
}

export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
