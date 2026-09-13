/**
 * Bun 1.3.14 TLS 主机名校验（安全评审实测）：
 * - fetch：按 tls.serverName 校验（URL host 为 IP 时仍看 serverName）。
 * - WS：只按 URL host 校验；serverName 仅 SNI。URL host 为 IP 字面量时跳过 SAN。
 *   本地实测：SAN=hub.test 的证书，WS(127.0.0.1) 无论 serverName/ca 全部 OPEN。
 * 因此按 IP 重拨 WebSocket 前必须先用 fetch 做身份检查，通过才允许连该 IP。
 */
import { isIP } from 'node:net';
import type { WebSocketTransportInput } from '@vibeterm/shared/link';
import { waitSocketOpen } from '@vibeterm/shared/net';
import {
  type DohResolveOptions,
  isUnusableEdgeIp,
  resolveHostnameViaDoh,
} from '../tunnel/edge-resolver';
import { classifyRemoteAddress, isIpAddressLiteral } from './address-class';
import { DIAL_IDENTITY_PATH_HUB, checkDialIdentity } from './dial-identity';
import { stamp } from './mesh-log';
import { classifyUplinkConnectError } from './uplink-reconnect';
import { wsDialRaceCount } from './ws-dial-race-config';
import {
  WS_RACE_OPEN_TIMEOUT_MS,
  type WsDialContext,
  raceWebSocketOpen,
  wsRaceCountForUrl,
} from './ws-open-race';

export const DIAL_DNS_FALLBACK_ENV = 'VIBETERM_DIAL_DNS_FALLBACK';
export const DIAL_SYSTEM_LOOKUP_TIMEOUT_MS = 3_000;
export const DIAL_RESOLVE_TTL_MS = 60_000;
export const DIAL_RESOLVE_NEGATIVE_TTL_MS = 15_000;
export const DIAL_DOH_BUDGET_MS = 5_000;
export const DIAL_RESOLVE_CACHE_MAX = 64;
export {
  DIAL_IDENTITY_PATH_HUB,
  DIAL_IDENTITY_PATH_RELAY,
  type CheckDialIdentityOpts,
  checkDialIdentity,
  identityCheckUrl,
} from './dial-identity';

export type DialResolveVia = 'system' | 'doh';
export type DialResolveResult = { ip: string; via: DialResolveVia };
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
};

export type DialResolveFn = (
  host: string,
  opts?: Pick<ResolveDialHostOptions, 'signal'>
) => Promise<DialResolveResult | null>;

export type DialTlsBase = {
  ca?: string[];
  rejectUnauthorized?: boolean;
  serverName?: string;
};

export type DialSocketOpts = {
  tls: DialTlsBase;
  headers: { host: string };
};

export type DialWsCtor = (
  url: string,
  opts?: DialSocketOpts
) => WebSocketTransportInput | Promise<WebSocketTransportInput>;

export type DialWsFactory = (
  url: string,
  ctx?: WsDialContext
) => WebSocketTransportInput | Promise<WebSocketTransportInput>;

export type DialWsFactoryDeps = {
  wsCtor?: DialWsCtor;
  resolve?: DialResolveFn;
  enabled?: boolean;
  raceCount?: number;
  identityPath?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type FetchDnsFallbackOpts = {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  resolve?: DialResolveFn;
  enabled?: boolean;
};

type CacheEntry = { result: DialResolveResult | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<DialResolveResult | null>>();
const lastVia = new Map<string, DialResolveVia>();
const lastFailLogAt = new Map<string, number>();

const DNS_FAIL_RE =
  /\b(enotfound|dns_enotfound|eai_noname|eai_again|eai_fail|getaddrinfo|failedtoopensocket)\b|failed to connect|was there a typo in the url|name not resolved|nodename nor servname|unable to connect\. is the computer able to access the url/;

export function resetDialResolveForTest(): void {
  cache.clear();
  inflight.clear();
  lastVia.clear();
  lastFailLogAt.clear();
}

export function isDialDnsFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DIAL_DNS_FALLBACK_ENV]?.trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false' && raw !== 'no';
}

export function rewriteDialUrl(url: string, ip: string): string {
  const parsed = new URL(url);
  const bare = stripBrackets(ip);
  parsed.hostname = isIP(bare) === 6 ? `[${bare}]` : bare;
  return parsed.toString();
}

export function dialTlsForHost(
  hostname: string,
  headerHost: string,
  baseTls?: DialTlsBase | null
): DialSocketOpts | undefined {
  if (!hostname || !headerHost) return undefined;
  return {
    tls: { ...baseTls, serverName: hostname },
    headers: { host: headerHost },
  };
}

export function isDnsClassFailure(err: unknown): boolean {
  if (classifyUplinkConnectError(err) === 'dns') return true;
  return DNS_FAIL_RE.test(`${errorCode(err)} ${errorMessage(err)}`.toLowerCase());
}

export function hostOfDialUrl(url: string): string | null {
  try {
    const host = stripBrackets(new URL(url).hostname).trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export function hostHeaderOfDialUrl(url: string): string | null {
  try {
    const host = new URL(url).host.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

export async function resolveDialHost(
  host: string,
  opts: ResolveDialHostOptions = {}
): Promise<DialResolveResult | null> {
  const hostname = stripBrackets(host).trim().toLowerCase();
  if (!hostname) return null;
  if (isIpAddressLiteral(hostname)) return { ip: hostname, via: 'system' };
  const now = opts.now ?? Date.now;
  const cached = cacheGet(hostname, now());
  if (cached !== undefined) return cached;
  const pending = inflight.get(hostname);
  if (pending) return pending;
  const work = resolveUncached(hostname, opts).then((resolved) => {
    remember(hostname, resolved.result, now());
    noteTransition(hostname, resolved.result, resolved.reason);
    return resolved.result;
  });
  inflight.set(hostname, work);
  void work.finally(() => {
    if (inflight.get(hostname) === work) inflight.delete(hostname);
  });
  return work;
}

export function createDialWsFactory(
  tlsCa?: string[] | null,
  deps: DialWsFactoryDeps = {}
): DialWsFactory {
  const wsCtor = deps.wsCtor ?? defaultWsCtor;
  const resolve =
    deps.resolve ?? ((hostname, resolveOpts) => resolveDialHost(hostname, resolveOpts));
  const baseTls = tlsCa && tlsCa.length > 0 ? { ca: tlsCa } : undefined;
  return (url, ctx) => openDialSocket(url, ctx, { wsCtor, resolve, baseTls, deps });
}

export async function fetchWithDnsFallback(
  url: string,
  init: RequestInit = {},
  opts: FetchDnsFallbackOpts = {}
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
  try {
    return await doFetch(url, init);
  } catch (err) {
    const hostname = hostOfDialUrl(url);
    const headerHost = hostHeaderOfDialUrl(url);
    const resolve = opts.resolve ?? ((host, resolveOpts) => resolveDialHost(host, resolveOpts));
    const ipUrl = await fallbackDialUrl({
      url,
      host: hostname,
      err,
      resolve,
      enabled: opts.enabled,
      signal: init.signal ?? undefined,
    });
    if (!ipUrl || !hostname || !headerHost) throw err;
    const dial = dialTlsForHost(hostname, headerHost, (init as { tls?: DialTlsBase }).tls);
    return await doFetch(ipUrl, {
      ...init,
      ...(dial ? { tls: dial.tls } : {}),
      headers: { ...plainHeaders(init.headers), host: headerHost },
    } as RequestInit);
  }
}

async function openDialSocket(
  url: string,
  ctx: WsDialContext | undefined,
  state: {
    wsCtor: DialWsCtor;
    resolve: DialResolveFn;
    baseTls: DialTlsBase | undefined;
    deps: DialWsFactoryDeps;
  }
): Promise<WebSocketTransportInput> {
  const hostname = hostOfDialUrl(url);
  const headerHost = hostHeaderOfDialUrl(url);
  const socketOpts =
    hostname && headerHost ? dialTlsForHost(hostname, headerHost, state.baseTls) : undefined;
  const open = (target: string) => state.wsCtor(target, socketOpts);
  try {
    return await raceOrOpen(open, url, ctx, state.deps.raceCount);
  } catch (err) {
    const ipUrl = await fallbackDialUrl({
      url,
      host: hostname,
      err,
      resolve: state.resolve,
      enabled: state.deps.enabled,
      signal: ctx?.signal,
    });
    if (!ipUrl || !hostname || !headerHost) throw err;
    const ip = hostOfDialUrl(ipUrl);
    if (!ip) throw err;
    const verified = await checkDialIdentity({
      ip,
      hostname,
      headerHost,
      path: state.deps.identityPath ?? DIAL_IDENTITY_PATH_HUB,
      originalUrl: url,
      tls: state.baseTls,
      fetchImpl: state.deps.fetchImpl,
      signal: ctx?.signal,
    });
    if (!verified) throw err;
    return await raceOrOpen(open, ipUrl, ctx, state.deps.raceCount);
  }
}

async function raceOrOpen(
  factory: DialWsCtor,
  url: string,
  ctx: WsDialContext | undefined,
  raceCount: number | undefined
): Promise<WebSocketTransportInput> {
  const count = wsRaceCountForUrl(url, raceCount ?? wsDialRaceCount());
  if (count > 1) {
    return raceWebSocketOpen(factory, url, {
      count,
      timeoutMs: ctx?.timeoutMs,
      signal: ctx?.signal,
    });
  }
  const ws = await factory(url);
  await waitSocketOpen(ws as object, ctx?.timeoutMs ?? WS_RACE_OPEN_TIMEOUT_MS, ctx?.signal);
  return ws;
}

function defaultWsCtor(url: string, opts?: DialSocketOpts): WebSocketTransportInput {
  return new WebSocket(url, opts as never) as WebSocketTransportInput;
}

async function fallbackDialUrl(args: {
  url: string;
  host: string | null;
  err: unknown;
  resolve: DialResolveFn;
  enabled?: boolean;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { url, host, err, resolve, enabled, signal } = args;
  if (!fallbackOn(enabled) || !host || isIpAddressLiteral(host)) return null;
  if (isNonFallbackFailure(err) || !isDnsClassFailure(err)) return null;
  const resolved = await resolve(host, { signal });
  if (!resolved?.ip || resolved.via !== 'doh') return null;
  const ipUrl = rewriteDialUrl(url, resolved.ip);
  return ipUrl === url ? null : ipUrl;
}

function fallbackOn(override?: boolean): boolean {
  if (override === false) return false;
  if (override === true) return true;
  return isDialDnsFallbackEnabled();
}

function isNonFallbackFailure(err: unknown): boolean {
  const classified = classifyUplinkConnectError(err);
  if (classified === 'aborted' || classified === 'auth_rejected' || classified === 'protocol') {
    return true;
  }
  if (classified.startsWith('http_')) return true;
  const blob = `${errorCode(err)} ${errorMessage(err)}`.toLowerCase();
  return /\beconnrefused\b|\bconnectionrefused\b|connection refused/.test(blob);
}

async function resolveUncached(
  hostname: string,
  opts: ResolveDialHostOptions
): Promise<{ result: DialResolveResult | null; reason?: string }> {
  if (opts.signal?.aborted) return { result: null, reason: 'aborted' };
  const lookup = opts.lookup ?? defaultLookup;
  const systemIp = pickDialIp(
    await lookupTimed(
      lookup,
      hostname,
      opts.timeoutMs ?? DIAL_SYSTEM_LOOKUP_TIMEOUT_MS,
      opts.signal
    )
  );
  if (systemIp) return { result: { ip: systemIp, via: 'system' } };
  if (opts.signal?.aborted) return { result: null, reason: 'aborted' };
  if (!canUseDoh(opts)) return { result: null, reason: 'doh disabled' };
  const doh = opts.doh ?? resolveHostnameViaDoh;
  try {
    const dohIp = pickDialIp(
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

function pickDialIp(ips: readonly string[]): string | null {
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
  cache.delete(host);
  cache.set(host, { result, expiresAt: nowMs + ttl });
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

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plainHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
