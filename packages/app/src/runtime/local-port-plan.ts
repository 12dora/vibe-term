import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PEER_PORT,
  DEFAULT_PUBLIC_HTTPS_PORT,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  type PortPlanLive,
  type PortRange,
  type PortRole,
  type PortSpec,
  formatPortList,
  isLoopbackHostname,
  parsePortRange,
  parseProbeTarget,
  portPlanForRole,
} from '../../../shared/src/net';
import { isVibeTermRoleName } from '../../../shared/src/roles';

export type PortPlanEnv = Record<string, string | undefined>;

/** 公网 URL 里的端口；https 未写端口时为 443。解析失败返回 null。 */
export function parsePublicHttpsPort(url: string | null | undefined): number | null {
  const raw = url?.trim();
  if (!raw) return null;
  try {
    const target = parseProbeTarget(raw);
    if (target.explicitPort !== null) return target.explicitPort;
    if (target.protocol === 'https:') return DEFAULT_PUBLIC_HTTPS_PORT;
    return target.port;
  } catch {
    return null;
  }
}

export function isGatewayExposed(bindHost: string | undefined): boolean {
  const host = bindHost?.trim();
  if (!host) return false;
  return !isLoopbackHostname(host);
}

export function portRoleFromEnv(env: PortPlanEnv): PortRole {
  const raw = env.VIBETERM_ROLES?.trim() ?? '';
  return isVibeTermRoleName(raw) ? raw : 'standalone';
}

function parseDecimalPort(raw: string | undefined, fallback: number): number {
  const value = raw?.trim() ?? '';
  if (!value || !/^\d+$/.test(value)) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function parseTurnPortLive(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TURN_PORT;
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === '0') return 0;
  return parseDecimalPort(raw, DEFAULT_TURN_PORT);
}

function publicUrlForRole(role: PortRole, env: PortPlanEnv): string | undefined {
  if (role === 'relay' || role === 'relay,node') return env.VIBETERM_RELAY_PUBLIC_URL;
  if (role === 'hub,node') return env.VIBETERM_HUB_PUBLIC_URL;
  return env.VIBETERM_HUB_PUBLIC_URL || env.VIBETERM_RELAY_PUBLIC_URL;
}

export function portPlanLiveFromEnv(env: PortPlanEnv): PortPlanLive {
  const role = portRoleFromEnv(env);
  const rtcRange = parsePortRange(env.VIBETERM_RTC_PORT_RANGE ?? '');
  const turnRelayRange = parsePortRange(env.VIBETERM_TURN_RELAY_PORT_RANGE ?? '');
  return {
    gatewayPort: parseDecimalPort(env.GATEWAY_PORT, DEFAULT_GATEWAY_PORT),
    gatewayExposed: isGatewayExposed(env.VIBETERM_BIND_HOST),
    peerPort: parseDecimalPort(env.VIBETERM_PEER_PORT, DEFAULT_PEER_PORT),
    rtcRange,
    turnPort: parseTurnPortLive(env.VIBETERM_TURN_PORT),
    turnRelayRange: turnRelayRange ?? { ...DEFAULT_TURN_RELAY_PORT_RANGE },
    publicHttpsPort: parsePublicHttpsPort(publicUrlForRole(role, env)),
  };
}

export function portPlanFromEnv(env: PortPlanEnv): PortSpec[] {
  return portPlanForRole(portRoleFromEnv(env), portPlanLiveFromEnv(env));
}

export function formatPortPlanForEnv(env: PortPlanEnv): string {
  return formatPortList(portPlanFromEnv(env));
}

export function portPlanLiveFromValues(input: {
  gatewayPort: number;
  bindHost: string;
  peerPort: number;
  rtcRange?: PortRange | null;
  turnPort?: number | 0;
  turnRelayRange?: PortRange;
  publicUrl?: string | null;
}): PortPlanLive {
  return {
    gatewayPort: input.gatewayPort,
    gatewayExposed: isGatewayExposed(input.bindHost),
    peerPort: input.peerPort,
    rtcRange: input.rtcRange ?? null,
    turnPort: input.turnPort ?? DEFAULT_TURN_PORT,
    turnRelayRange: input.turnRelayRange ?? { ...DEFAULT_TURN_RELAY_PORT_RANGE },
    publicHttpsPort: parsePublicHttpsPort(input.publicUrl),
  };
}
