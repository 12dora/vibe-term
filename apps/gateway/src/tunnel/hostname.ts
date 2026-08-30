const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

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
  return `tmex-${firstHostnameLabel(hostname)}`;
}
