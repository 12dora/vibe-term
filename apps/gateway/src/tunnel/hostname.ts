import type { TunnelMode } from '@tmex/shared';
import { TunnelError } from './errors';

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

/** Access 应用挂哪个主机名：显式参数优先，其次隧道已配置的主机名，sync 时可回落到外部检测结果。 */
export function resolveAccessHostname(input: {
  explicit?: string;
  mode: TunnelMode;
  tunnelHostname: string | null;
  externalHostname?: string;
  forSync?: boolean;
}): string {
  if (input.explicit !== undefined) {
    const hostname = normalizeTunnelHostname(input.explicit);
    if (!hostname) {
      throw new TunnelError('invalid_hostname', 'hostname is not a valid RFC 1123 name');
    }
    return hostname;
  }
  if (input.tunnelHostname) return input.tunnelHostname;
  if (input.forSync && input.externalHostname) return input.externalHostname;
  if (input.mode === 'off') {
    throw new TunnelError(
      'not_configured',
      'hostname is required when the tunnel is not configured'
    );
  }
  throw new TunnelError('not_configured', 'named tunnel hostname is required');
}
