const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;
const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;
const TUNNEL_NAME_MAX = 63;

export function normalizeTunnelHostname(raw: string): string | null {
  const hostname = raw.trim().toLowerCase();
  if (!hostname || !HOSTNAME_RE.test(hostname)) return null;
  return hostname;
}

export function firstHostnameLabel(hostname: string): string {
  const label = hostname.split('.')[0]?.trim() ?? '';
  return label || 'tmex';
}

export function defaultTunnelName(hostname: string): string {
  return `tmex-${firstHostnameLabel(hostname)}`.slice(0, TUNNEL_NAME_MAX);
}

export function normalizeTunnelName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  if (!TUNNEL_NAME_RE.test(name)) return null;
  return name;
}
