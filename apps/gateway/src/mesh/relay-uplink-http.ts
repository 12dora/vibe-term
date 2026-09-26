import {
  type LinkSession,
  WebSocketLink,
  type WebSocketTransportInput,
} from '@vibeterm/shared/link';
import { waitSocketOpen } from '@vibeterm/shared/net';
import {
  type DialWsFactoryDeps,
  type FetchDnsFallbackOpts,
  createDialWsFactory,
  fetchWithDnsFallback,
} from './dial-resolve';
import {
  type RelayDialContext,
  relayDialContextFromEnv,
  relayTlsCaForDial,
  resolveRelayDialUrl,
} from './relay-dial';
import {
  UPLINK_AUTH_TIMEOUT_MS,
  type UplinkWsFactory,
  uplinkWebSocketTls,
} from './uplink-constants';
import { classifyUplinkConnectError, closeTransport } from './uplink-reconnect';

export const RELAY_UPLINK_PATH = '/relay/uplink';
export const RELAY_HEALTH_PATH = '/api/relay/health';

export function relayUplinkWsUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  url.pathname = RELAY_UPLINK_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * 健康探测。与拨号同一条改写：`relay,node` 机器探自己的中继时走回环，
 * 否则 hairpin NAT 下这一探必然超时，池子会把本机中继判成不可用。
 */
export async function probeRelayHealth(
  publicUrl: string,
  tlsCa: string[] | null,
  timeoutMs: number,
  dial: RelayDialContext = relayDialContextFromEnv(),
  fallback?: FetchDnsFallbackOpts
): Promise<boolean> {
  const dialUrl = resolveRelayDialUrl(publicUrl, dial);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('connect-timeout')), timeoutMs);
  const timedOut = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error('probe_timeout'));
    if (ac.signal.aborted) fail();
    else ac.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    const init: RequestInit = { method: 'GET', signal: ac.signal, redirect: 'error' };
    const tls = uplinkWebSocketTls(relayTlsCaForDial(dialUrl, tlsCa));
    if (tls) Object.assign(init, tls);
    const url = `${dialUrl.replace(/\/+$/, '')}${RELAY_HEALTH_PATH}`;
    const res = await Promise.race([
      fetchWithDnsFallback(url, init, { ...fallback, timeoutMs, preserveDoh: true }),
      timedOut,
    ]);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}

export type OpenRelayLinkOpts = {
  timeoutMs: number;
  authTimeoutMs?: number;
  createLink?: (ws: WebSocketTransportInput) => LinkSession;
};

/** 拨号 `/relay/uplink`：连接段与 auth 段分开计时，auth 失败不记成 `connect-timeout`。 */
export async function openRelayLink(
  wsFactory: UplinkWsFactory,
  relayUrl: string,
  signal: AbortSignal,
  attach: (link: LinkSession, signal: AbortSignal) => Promise<void>,
  opts: OpenRelayLinkOpts
): Promise<void> {
  const startedAt = Date.now();
  const authBudget = opts.authTimeoutMs ?? UPLINK_AUTH_TIMEOUT_MS;
  const ws = await openRelaySocket(
    wsFactory,
    relayUrl,
    remainingMs(opts.timeoutMs, startedAt),
    signal
  );
  const authMs = Math.min(authBudget, remainingMs(opts.timeoutMs + authBudget, startedAt));
  await attachRelayAuth(ws, authMs, signal, attach, opts.createLink);
}

export function defaultRelayWsFactory(
  tlsCa?: string[] | null,
  deps?: DialWsFactoryDeps
): UplinkWsFactory {
  return createDialWsFactory(tlsCa, {
    ...deps,
    identityPath: deps?.identityPath ?? RELAY_HEALTH_PATH,
  });
}

export function remainingMs(budgetMs: number, startedAt: number, now = Date.now()): number {
  return Math.max(1, budgetMs - (now - startedAt));
}

export function remapRelayOpenError(
  err: unknown,
  stage: 'connect' | 'auth',
  stageSignal: AbortSignal,
  parent: AbortSignal
): Error {
  if (parent.aborted) return asError(err, 'aborted');
  const msg = err instanceof Error ? err.message.trim() : String(err);
  if (stage === 'auth') return remapAuthStageError(err, msg, stageSignal);
  if (stageSignal.aborted) return new Error('connect-timeout');
  return remapConnectStageError(err, msg);
}

function remapAuthStageError(err: unknown, msg: string, stageSignal: AbortSignal): Error {
  if (stageSignal.aborted || msg === 'auth-timeout' || msg === 'connect-timeout') {
    return new Error('auth-timeout');
  }
  return asError(err, msg || 'auth-failed');
}

function remapConnectStageError(err: unknown, msg: string): Error {
  const code = classifyUplinkConnectError(err);
  if (code === 'dns') return new Error('dns-failed');
  if (code === 'tls') return new Error('tls-failed');
  if (code === 'timeout' || msg === 'connect-timeout') return new Error('connect-timeout');
  if (msg === 'aborted' || isStableReason(msg)) return asError(err, msg);
  return new Error('connect-failed');
}

async function openRelaySocket(
  wsFactory: UplinkWsFactory,
  relayUrl: string,
  budgetMs: number,
  parent: AbortSignal
): Promise<WebSocketTransportInput> {
  const startedAt = Date.now();
  const stage = bindStageAbort(parent, 'connect-timeout', budgetMs);
  let ws: WebSocketTransportInput | null = null;
  try {
    ws = await wsFactory(relayUplinkWsUrl(relayUrl), {
      signal: stage.signal,
      timeoutMs: budgetMs,
    });
    if (stage.signal.aborted) {
      closeTransport(ws);
      throw new Error('connect-timeout');
    }
    await waitRelaySocketOpen(ws, remainingMs(budgetMs, startedAt), stage.signal);
    return ws;
  } catch (err) {
    if (ws) closeTransport(ws);
    throw remapRelayOpenError(err, 'connect', stage.signal, parent);
  } finally {
    stage.dispose();
  }
}

async function attachRelayAuth(
  ws: WebSocketTransportInput,
  budgetMs: number,
  parent: AbortSignal,
  attach: (link: LinkSession, signal: AbortSignal) => Promise<void>,
  createLink?: (ws: WebSocketTransportInput) => LinkSession
): Promise<void> {
  const stage = bindStageAbort(parent, 'auth-timeout', budgetMs);
  const link = createLink ? createLink(ws) : new WebSocketLink(ws, { role: 'initiator' });
  try {
    await runWithAbort(() => attach(link, stage.signal), stage.signal);
  } catch (err) {
    throw remapRelayOpenError(err, 'auth', stage.signal, parent);
  } finally {
    stage.dispose();
  }
}

function waitRelaySocketOpen(
  ws: WebSocketTransportInput,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  if (socketAlreadyOpen(ws)) return Promise.resolve();
  return waitSocketOpen(ws, timeoutMs, signal);
}

function socketAlreadyOpen(ws: object): boolean {
  if (typeof (ws as { onDrain?: unknown }).onDrain === 'function') return true;
  return (ws as { readyState?: number }).readyState === 1;
}

function bindStageAbort(
  parent: AbortSignal,
  reason: 'connect-timeout' | 'auth-timeout',
  budgetMs: number
): { signal: AbortSignal; dispose: () => void } {
  const stage = new AbortController();
  const timer = setTimeout(() => stage.abort(new Error(reason)), budgetMs);
  const onParent = () => {
    if (!stage.signal.aborted) stage.abort(parent.reason);
  };
  if (parent.aborted) onParent();
  else parent.addEventListener('abort', onParent, { once: true });
  return {
    signal: stage.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParent);
    },
  };
}

function asError(err: unknown, fallback: string): Error {
  if (err instanceof Error && err.message) return err;
  return new Error(fallback);
}

function runWithAbort<T>(op: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void op().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

function isStableReason(msg: string): boolean {
  return msg.length <= 64 && /^[a-z0-9_.:-]+$/i.test(msg);
}
