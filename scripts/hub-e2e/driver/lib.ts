export type CookieMap = Record<string, string>;

export interface LoginState {
  cookies: CookieMap;
  cookieHeader: string;
  uid: string;
  nodeId: string;
  username: string | null;
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) {
      const rest = (out._ as string | undefined) ? `${out._ as string} ${token}` : (token ?? '');
      out._ = rest;
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function requireArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return value;
}

export function cookieHeaderFromMap(cookies: CookieMap): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function mergeSetCookies(current: CookieMap, headers: Headers): CookieMap {
  const next = { ...current };
  const listed = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  for (const line of listed) {
    const pair = line.split(';', 1)[0];
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    next[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return next;
}

export async function loadLoginState(path: string): Promise<LoginState> {
  const text = await Bun.file(path).text();
  return JSON.parse(text) as LoginState;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function apiFetch(
  baseUrl: string,
  path: string,
  init: RequestInit & { cookies?: CookieMap } = {}
): Promise<{ res: Response; cookies: CookieMap; json: unknown; text: string }> {
  const cookies = { ...(init.cookies ?? {}) };
  const headers = new Headers(init.headers);
  const cookie = cookieHeaderFromMap(cookies);
  if (cookie) headers.set('cookie', cookie);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(joinUrl(baseUrl, path), {
    ...init,
    headers,
  });
  const nextCookies = mergeSetCookies(cookies, res.headers);
  const text = await res.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { res, cookies: nextCookies, json, text };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 1000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms${lastError instanceof Error ? `: ${lastError.message}` : ''}`
  );
}
