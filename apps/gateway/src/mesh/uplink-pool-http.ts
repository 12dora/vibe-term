import { type FetchDnsFallbackOpts, fetchWithDnsFallback } from './dial-resolve';
import { uplinkWebSocketTls } from './uplink-constants';

export function joinHubPath(publicUrl: string, path: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${path}`;
}

export async function defaultProbeHealthz(
  publicUrl: string,
  tlsCa: string[] | null,
  timeoutMs: number,
  fallback?: FetchDnsFallbackOpts
): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const timedOut = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error('probe_timeout'));
    if (ac.signal.aborted) fail();
    else ac.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    const init: RequestInit = { method: 'GET', signal: ac.signal, redirect: 'error' };
    const tls = uplinkWebSocketTls(tlsCa);
    if (tls) Object.assign(init, tls);
    const res = await Promise.race([
      fetchWithDnsFallback(joinHubPath(publicUrl, '/healthz'), init, fallback),
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
