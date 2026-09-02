import { uplinkWebSocketTls } from './uplink-client';

export const CA_BOOTSTRAP_TIMEOUT_MS = 5_000;
export const CA_BOOTSTRAP_MAX_BYTES = 64 * 1024;

export function joinHubPath(publicUrl: string, path: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${path}`;
}

export async function readResponseTextLimited(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error('ca_too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

export async function defaultProbeHealthz(
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
    const res = await fetch(joinHubPath(publicUrl, '/healthz'), init);
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function defaultFetchCaPem(
  publicUrl: string,
  opts?: {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    timeoutMs?: number;
    maxBytes?: number;
  }
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? CA_BOOTSTRAP_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? CA_BOOTSTRAP_MAX_BYTES;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const timedOut = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error('ca_timeout'));
    if (ac.signal.aborted) fail();
    else ac.signal.addEventListener('abort', fail, { once: true });
  });
  try {
    const doFetch = opts?.fetch ?? fetch;
    const res = await Promise.race([
      doFetch(joinHubPath(publicUrl, '/api/tls/ca.crt'), {
        redirect: 'error',
        signal: ac.signal,
        tls: { rejectUnauthorized: false },
      } as RequestInit),
      timedOut,
    ]);
    if (!res.ok) throw new Error('ca_unavailable');
    return await Promise.race([readResponseTextLimited(res, maxBytes), timedOut]);
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}
