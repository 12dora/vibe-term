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

export function nodeSessionCookieName(nodeId: string): string {
  return `tmex_s_${nodeId}`;
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
}

export function clearNodeSessionCookie(
  headers: Headers,
  nodeId: string,
  options?: { secure?: boolean }
): void {
  if (!isCanonicalNodeId(nodeId)) return;
  headers.append('set-cookie', buildClearCookie(nodeSessionCookieName(nodeId), options));
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
