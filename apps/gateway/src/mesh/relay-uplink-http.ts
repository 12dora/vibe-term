import { type LinkSession, WebSocketLink, type WebSocketTransportInput } from '@tmex/shared/link';
import { waitSocketOpen } from '@tmex/shared/net';
import { type UplinkWsFactory, uplinkWebSocketTls } from './uplink-client';
import { closeTransport } from './uplink-reconnect';

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

export async function probeRelayHealth(
  publicUrl: string,
  tlsCa: string[] | null,
  timeoutMs: number
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const init: RequestInit = { method: 'GET', signal: ac.signal, redirect: 'error' };
    const tls = uplinkWebSocketTls(tlsCa);
    if (tls) Object.assign(init, tls);
    const res = await fetch(`${publicUrl.replace(/\/+$/, '')}${RELAY_HEALTH_PATH}`, init);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 拨号 `/relay/uplink` 并完成 WebSocket 握手；超时统一报 `connect-timeout`。 */
export async function openRelayLink(
  wsFactory: UplinkWsFactory,
  relayUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
  attach: (link: LinkSession, signal: AbortSignal) => Promise<void>
): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('connect-timeout')), timeoutMs);
  const onParentAbort = () => {
    if (!timeout.signal.aborted) timeout.abort(signal.reason);
  };
  if (signal.aborted) onParentAbort();
  else signal.addEventListener('abort', onParentAbort, { once: true });
  try {
    const ws = await wsFactory(relayUplinkWsUrl(relayUrl));
    if (timeout.signal.aborted) {
      closeTransport(ws);
      throw new Error('connect-timeout');
    }
    await waitSocketOpen(ws, timeoutMs, timeout.signal);
    await attach(new WebSocketLink(ws, { role: 'initiator' }), timeout.signal);
  } catch (err) {
    if (timeout.signal.aborted && !signal.aborted) throw new Error('connect-timeout');
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

export function defaultRelayWsFactory(tlsCa?: string[] | null): UplinkWsFactory {
  return (url) => {
    const tls = uplinkWebSocketTls(tlsCa);
    return (tls ? new WebSocket(url, tls as never) : new WebSocket(url)) as WebSocketTransportInput;
  };
}
