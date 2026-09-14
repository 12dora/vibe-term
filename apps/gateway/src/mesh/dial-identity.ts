import { isIP } from 'node:net';
import { stamp } from './mesh-log';

export const DIAL_IDENTITY_PATH_HEALTHZ = '/healthz';
export const DIAL_IDENTITY_PATH_RELAY = '/api/relay/health';

export type CheckDialIdentityOpts = {
  ip: string;
  hostname: string;
  headerHost?: string;
  path: string;
  originalUrl?: string;
  tls?: { ca?: string[]; rejectUnauthorized?: boolean; serverName?: string } | null;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
};

export function identityCheckUrl(opts: CheckDialIdentityOpts): string {
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  if (opts.originalUrl) {
    const parsed = new URL(opts.originalUrl);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    parsed.pathname = path;
    parsed.search = '';
    parsed.hash = '';
    const bare = stripBrackets(opts.ip);
    parsed.hostname = isIP(bare) === 6 ? `[${bare}]` : bare;
    return parsed.toString();
  }
  const bare = stripBrackets(opts.ip);
  const host = isIP(bare) === 6 ? `[${bare}]` : bare;
  return `https://${host}${path}`;
}

export async function checkDialIdentity(opts: CheckDialIdentityOpts): Promise<boolean> {
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = identityCheckUrl(opts);
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: { host: opts.headerHost ?? opts.hostname },
      signal: opts.signal,
    };
    if (url.startsWith('https:')) {
      Object.assign(init, { tls: { ...opts.tls, serverName: opts.hostname } });
    }
    await doFetch(url, init);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      stamp(
        `[uplink] dns fallback identity check failed host=${opts.hostname} ip=${opts.ip} err=${message}`
      )
    );
    return false;
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
