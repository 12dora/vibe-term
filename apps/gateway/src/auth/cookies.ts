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
