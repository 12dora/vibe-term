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
import { isIpAddressLiteral } from './address-class';
import { runFakeThenRedial } from './dial-connect-budget';
import {
  connectFailureReason,
  isConnectClassFailure,
  isDnsClassFailure,
  isHardNonFallback,
} from './dial-error';
import { DIAL_IDENTITY_PATH_HEALTHZ, checkDialIdentity } from './dial-identity';
import {
  type DialResolveFn,
  type DialResolveResult,
  fallbackOn,
  forgetPreferDoh,
  noteFakeIpRedial,
  peekPreferDoh,
  resolveDialHost,
  stripBrackets,
} from './dial-resolve-host';
import { wsDialRaceCount } from './ws-dial-race-config';
import {
  WS_RACE_OPEN_TIMEOUT_MS,
  type WsDialContext,
  raceWebSocketOpen,
  wsRaceCountForUrl,
} from './ws-open-race';

export {
  DIAL_DNS_FALLBACK_ENV,
  DIAL_DOH_BUDGET_MS,
  DIAL_RESOLVE_CACHE_MAX,
  DIAL_RESOLVE_NEGATIVE_TTL_MS,
  DIAL_RESOLVE_TTL_MS,
  DIAL_SYSTEM_LOOKUP_TIMEOUT_MS,
  type DialDoh,
  type DialLookup,
  type DialResolveFn,
  type DialResolveResult,
  type DialResolveVia,
  type ResolveDialHostOptions,
  fallbackOn,
  isDialDnsFallbackEnabled,
  resetDialResolveForTest,
  resolveDialHost,
} from './dial-resolve-host';
export {
  DIAL_IDENTITY_PATH_HEALTHZ,
  DIAL_IDENTITY_PATH_RELAY,
  type CheckDialIdentityOpts,
  checkDialIdentity,
  identityCheckUrl,
} from './dial-identity';
export { isConnectClassFailure, isDnsClassFailure } from './dial-error';

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
  timeoutMs?: number;
  /** 健康探测失败不抹掉 uplink 正在用的 DoH 偏好。 */
  preserveDoh?: boolean;
};

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
  const session = bindFetchSession(url, init, opts);
  const preferred = preferredIpUrl(url, session.hostname, opts.enabled);
  if (preferred) {
    try {
      return await session.fetchIp(preferred);
    } catch {
      forgetFetchDoh(session);
    }
  }
  if (await hostResolvesFake(session.hostname, opts.enabled, session.resolve, session.parent)) {
    return await fetchFakeThenDoh(url, init, session);
  }
  try {
    return await session.doFetch(url, init);
  } catch (err) {
    return await fetchRedialIp(url, err, session, session.parent);
  }
}

type DialSession = {
  hostname: string | null;
  headerHost: string | null;
  open: DialWsCtor;
  resolve: DialResolveFn;
  baseTls: DialTlsBase | undefined;
  deps: DialWsFactoryDeps;
  ctx: WsDialContext | undefined;
};

type FetchSession = {
  hostname: string | null;
  headerHost: string | null;
  resolve: DialResolveFn;
  parent: AbortSignal | undefined;
  timeoutMs: number | undefined;
  enabled: boolean | undefined;
  preserveDoh: boolean;
  doFetch: (input: string, init?: RequestInit) => Promise<Response>;
  fetchIp: (ipUrl: string, signal?: AbortSignal) => Promise<Response>;
};

function forgetFetchDoh(session: Pick<FetchSession, 'hostname' | 'preserveDoh'>): void {
  if (session.preserveDoh || !session.hostname) return;
  forgetPreferDoh(session.hostname);
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
  const session = bindDialSession(url, ctx, state);
  const preferred = preferredIpUrl(url, session.hostname, state.deps.enabled);
  if (preferred && session.hostname && session.headerHost) {
    const ws = await openVerifiedIp({ ipUrl: preferred, originalUrl: url, session });
    if (ws) return ws;
    forgetPreferDoh(session.hostname);
  }
  if (await hostResolvesFake(session.hostname, state.deps.enabled, session.resolve, ctx?.signal)) {
    return await openFakeThenDoh(url, session);
  }
  try {
    return await raceSession(session, url);
  } catch (err) {
    return await redialAfterFailure(url, err, session);
  }
}

function bindDialSession(
  url: string,
  ctx: WsDialContext | undefined,
  state: {
    wsCtor: DialWsCtor;
    resolve: DialResolveFn;
    baseTls: DialTlsBase | undefined;
    deps: DialWsFactoryDeps;
  }
): DialSession {
  const hostname = hostOfDialUrl(url);
  const headerHost = hostHeaderOfDialUrl(url);
  const socketOpts =
    hostname && headerHost ? dialTlsForHost(hostname, headerHost, state.baseTls) : undefined;
  return {
    hostname,
    headerHost,
    open: (target: string) => state.wsCtor(target, socketOpts),
    resolve: state.resolve,
    baseTls: state.baseTls,
    deps: state.deps,
    ctx,
  };
}

function raceSession(session: DialSession, target: string): Promise<WebSocketTransportInput> {
  return raceOrOpen(session.open, target, session.ctx, session.deps.raceCount);
}

function withDialBudget(session: DialSession, signal: AbortSignal, timeoutMs: number): DialSession {
  return { ...session, ctx: { signal, timeoutMs } };
}

async function openFakeThenDoh(
  url: string,
  session: DialSession
): Promise<WebSocketTransportInput> {
  return await runFakeThenRedial({
    parent: session.ctx?.signal,
    timeoutMs: session.ctx?.timeoutMs,
    first: (signal, timeoutMs) => raceSession(withDialBudget(session, signal, timeoutMs), url),
    redial: (err, signal, timeoutMs) =>
      redialAfterFailure(url, err, withDialBudget(session, signal, timeoutMs)),
  });
}

async function redialAfterFailure(
  url: string,
  err: unknown,
  session: DialSession
): Promise<WebSocketTransportInput> {
  const ipUrl = await fallbackDialUrl({
    url,
    host: session.hostname,
    err,
    resolve: session.resolve,
    enabled: session.deps.enabled,
    signal: session.ctx?.signal,
  });
  if (!ipUrl || !session.hostname || !session.headerHost) throw err;
  const opened = await openVerifiedIp({ ipUrl, originalUrl: url, session });
  if (!opened) throw err;
  return opened;
}

async function openVerifiedIp(args: {
  ipUrl: string;
  originalUrl: string;
  session: DialSession;
}): Promise<WebSocketTransportInput | null> {
  const ip = hostOfDialUrl(args.ipUrl);
  if (!ip || !args.session.hostname || !args.session.headerHost) return null;
  const verified = await checkDialIdentity({
    ip,
    hostname: args.session.hostname,
    headerHost: args.session.headerHost,
    path: args.session.deps.identityPath ?? DIAL_IDENTITY_PATH_HEALTHZ,
    originalUrl: args.originalUrl,
    tls: args.session.baseTls,
    fetchImpl: args.session.deps.fetchImpl,
    signal: args.session.ctx?.signal,
  });
  if (!verified) return null;
  try {
    return await raceSession(args.session, args.ipUrl);
  } catch {
    if (args.session.hostname) forgetPreferDoh(args.session.hostname);
    return null;
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

type FallbackArgs = {
  url: string;
  host: string | null;
  err: unknown;
  resolve: DialResolveFn;
  enabled?: boolean;
  signal?: AbortSignal;
};

async function fallbackDialUrl(args: FallbackArgs): Promise<string | null> {
  if (!canStartFallback(args)) return null;
  if (isDnsClassFailure(args.err) && !isConnectClassFailure(args.err)) {
    return await rewriteIfDoh(
      args.url,
      await args.resolve(args.host as string, { signal: args.signal })
    );
  }
  return await fallbackFakeIpUrl(args);
}

function canStartFallback(args: FallbackArgs): boolean {
  if (!fallbackOn(args.enabled) || !args.host || isIpAddressLiteral(args.host)) return false;
  return !isHardNonFallback(args.err);
}

async function fallbackFakeIpUrl(args: FallbackArgs): Promise<string | null> {
  if (!isConnectClassFailure(args.err) || !args.host) return null;
  const resolved = await args.resolve(args.host, { signal: args.signal });
  if (!resolved?.fake || !resolved.ip) return null;
  const doh = await args.resolve(args.host, { signal: args.signal, preferDoh: true });
  if (!doh?.ip || doh.via !== 'doh') return null;
  const ipUrl = rewriteDialUrl(args.url, doh.ip);
  if (ipUrl === args.url) return null;
  noteFakeIpRedial(args.host, resolved.ip, doh.ip, connectFailureReason(args.err));
  return ipUrl;
}

function rewriteIfDoh(url: string, resolved: DialResolveResult | null): string | null {
  if (!resolved?.ip || resolved.via !== 'doh') return null;
  const ipUrl = rewriteDialUrl(url, resolved.ip);
  return ipUrl === url ? null : ipUrl;
}

function preferredIpUrl(url: string, host: string | null, enabled?: boolean): string | null {
  if (!fallbackOn(enabled) || !host || isIpAddressLiteral(host)) return null;
  const preferred = peekPreferDoh(host);
  if (!preferred?.ip) return null;
  const ipUrl = rewriteDialUrl(url, preferred.ip);
  return ipUrl === url ? null : ipUrl;
}

function tlsOf(init: RequestInit): DialTlsBase | undefined {
  return (init as { tls?: DialTlsBase }).tls;
}

function bindFetchSession(
  url: string,
  init: RequestInit,
  opts: FetchDnsFallbackOpts
): FetchSession {
  const hostname = hostOfDialUrl(url);
  const headerHost = hostHeaderOfDialUrl(url);
  const doFetch = opts.fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
  const resolve = opts.resolve ?? ((host, resolveOpts) => resolveDialHost(host, resolveOpts));
  const parent = init.signal ?? undefined;
  return {
    hostname,
    headerHost,
    resolve,
    parent,
    timeoutMs: opts.timeoutMs,
    enabled: opts.enabled,
    preserveDoh: opts.preserveDoh === true,
    doFetch,
    fetchIp: (ipUrl, signal) => {
      const dial =
        hostname && headerHost ? dialTlsForHost(hostname, headerHost, tlsOf(init)) : undefined;
      return doFetch(ipUrl, {
        ...init,
        ...(dial ? { tls: dial.tls } : {}),
        headers: { ...plainHeaders(init.headers), host: headerHost ?? '' },
        signal: signal ?? parent,
      } as RequestInit);
    },
  };
}

async function fetchFakeThenDoh(
  url: string,
  init: RequestInit,
  session: FetchSession
): Promise<Response> {
  return await runFakeThenRedial({
    parent: session.parent,
    timeoutMs: session.timeoutMs,
    first: (signal) => session.doFetch(url, { ...init, signal }),
    redial: (err, signal) => fetchRedialIp(url, err, session, signal),
  });
}

async function fetchRedialIp(
  url: string,
  err: unknown,
  session: FetchSession,
  signal: AbortSignal | undefined
): Promise<Response> {
  const ipUrl = await fallbackDialUrl({
    url,
    host: session.hostname,
    err,
    resolve: session.resolve,
    enabled: session.enabled,
    signal,
  });
  if (!ipUrl || !session.hostname || !session.headerHost) throw err;
  try {
    return await session.fetchIp(ipUrl, signal);
  } catch (ipErr) {
    forgetFetchDoh(session);
    throw ipErr;
  }
}

async function hostResolvesFake(
  host: string | null,
  enabled: boolean | undefined,
  resolve: DialResolveFn,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (!fallbackOn(enabled) || !host || isIpAddressLiteral(host)) return false;
  try {
    const resolved = await resolve(host, { signal });
    return resolved?.fake === true;
  } catch {
    return false;
  }
}

function plainHeaders(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
