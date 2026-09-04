import { hubHostFromUrl } from '@tmex/shared/auth';
import { parseTmexRoles, resolveGatewayPort } from '../config';

export type RelayDialContext = {
  roles: { relay: boolean };
  relayPublicUrl: string | null | undefined;
  gatewayPort: number;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function relayDialContextFromRuntime(input: {
  roles: { relay?: boolean };
  relayPublicUrl?: string | null;
  gatewayPort: number;
}): RelayDialContext {
  const publicUrl = input.relayPublicUrl?.trim();
  return {
    roles: { relay: Boolean(input.roles.relay) },
    relayPublicUrl: publicUrl ? publicUrl : null,
    gatewayPort: input.gatewayPort,
  };
}

export function relayDialContextFromEnv(env: NodeJS.ProcessEnv = process.env): RelayDialContext {
  let roles = { relay: false };
  try {
    roles = parseTmexRoles(env.TMEX_ROLES);
  } catch {
    /* 非法 TMEX_ROLES：不当成本机中继，不改写拨号 */
  }
  let gatewayPort = 0;
  try {
    gatewayPort = resolveGatewayPort(env);
  } catch {
    gatewayPort = 0;
  }
  return relayDialContextFromRuntime({
    roles,
    relayPublicUrl: env.TMEX_RELAY_PUBLIC_URL,
    gatewayPort,
  });
}

export function isLoopbackRelayDial(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function relayTlsCaForDial(
  dialUrl: string,
  tlsCa: string[] | null | undefined
): string[] | null {
  if (isLoopbackRelayDial(dialUrl)) return null;
  return tlsCa && tlsCa.length > 0 ? tlsCa : null;
}

/**
 * `relay,node` 本机接入自己的中继时，把公网 URL 改写成回环，避开 hairpin NAT。
 * 认证签名仍绑定 `TMEX_RELAY_PUBLIC_URL` 的 host，这里只改拨号地址。
 */
export function resolveRelayDialUrl(url: string, ctx: RelayDialContext): string {
  if (!ctx.roles.relay) return url;
  const publicUrl = ctx.relayPublicUrl?.trim();
  if (!publicUrl) return url;
  let targetHost: string;
  let publicHost: string;
  try {
    targetHost = hubHostFromUrl(url);
    publicHost = hubHostFromUrl(publicUrl);
  } catch {
    return url;
  }
  if (targetHost !== publicHost) return url;
  const port = ctx.gatewayPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return url;
  return `http://127.0.0.1:${port}`;
}
