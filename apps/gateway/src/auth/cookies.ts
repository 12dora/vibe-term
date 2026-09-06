const CANONICAL_NODE_ID_HEX = /^[0-9a-f]{32}$/;
const SAFE_ERROR_LOG_NAMES = new Set(['PeerHandshakeError', 'LinkError']);

export function parseCookies(header: string | null | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name) {
      continue;
    }
    cookies.set(name, part.slice(separator + 1).trim());
  }
  return cookies;
}

export function isCanonicalNodeId(id: string): boolean {
  return CANONICAL_NODE_ID_HEX.test(id);
}

export const NODE_SESSION_COOKIE_PREFIX = 'vibeterm_s_';
/** tmex 时期的会话 cookie 前缀：混合版本期同时签发与读取，全网 ≥2.0 后可删。 */
export const LEGACY_NODE_SESSION_COOKIE_PREFIX = 'tmex_s_';

export function nodeSessionCookieName(nodeId: string): string {
  return `${NODE_SESSION_COOKIE_PREFIX}${nodeId}`;
}

export function legacyNodeSessionCookieName(nodeId: string): string {
  return `${LEGACY_NODE_SESSION_COOKIE_PREFIX}${nodeId}`;
}

/** 读会话 cookie：新名优先，回退旧名。 */
export function readNodeSessionCookie(cookies: Map<string, string>, nodeId: string): string | null {
  return (
    cookies.get(nodeSessionCookieName(nodeId)) ??
    cookies.get(legacyNodeSessionCookieName(nodeId)) ??
    null
  );
}

export function hasNodeSessionCookie(cookies: Map<string, string>, nodeId: string): boolean {
  return (
    cookies.has(nodeSessionCookieName(nodeId)) || cookies.has(legacyNodeSessionCookieName(nodeId))
  );
}

export function buildSetCookie(
  name: string,
  value: string,
  options: { maxAgeSec: number; secure: boolean }
): string {
  const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${options.maxAgeSec}`;
  return options.secure ? `${cookie}; Secure` : cookie;
}

export function buildClearCookie(name: string, options?: { secure?: boolean }): string {
  const cookie = `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  return options?.secure ? `${cookie}; Secure` : cookie;
}

export function appendNodeSessionCookie(
  headers: Headers,
  nodeId: string,
  value: string,
  options: { maxAgeSec: number; secure: boolean }
): void {
  if (!isCanonicalNodeId(nodeId)) return;
  headers.append('set-cookie', buildSetCookie(nodeSessionCookieName(nodeId), value, options));
  headers.append('set-cookie', buildSetCookie(legacyNodeSessionCookieName(nodeId), value, options));
}

export function clearNodeSessionCookie(
  headers: Headers,
  nodeId: string,
  options?: { secure?: boolean }
): void {
  if (!isCanonicalNodeId(nodeId)) return;
  headers.append('set-cookie', buildClearCookie(nodeSessionCookieName(nodeId), options));
  headers.append('set-cookie', buildClearCookie(legacyNodeSessionCookieName(nodeId), options));
}

export function formatSafeErrorLog(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const code =
    SAFE_ERROR_LOG_NAMES.has(e.name) && 'code' in e && typeof e.code === 'string'
      ? e.code
      : 'unknown';
  let summary = '';
  for (const ch of e.message) {
    const c = ch.charCodeAt(0);
    if (c > 31 && (c < 127 || c > 159)) summary += ch;
  }
  return `reason=${code} summary=${summary.trim().slice(0, 120)}`;
}
