import { type MeshPortReach, roleNameFromFlags } from '@vibeterm/shared';
import {
  DEFAULT_PUBLIC_HTTPS_PORT,
  type PortPlanLive,
  type PortSpec,
  defaultRtcPortRange,
  isLoopbackHostname,
  parseProbeTarget,
  portPlanForRole,
} from '@vibeterm/shared/net';
import { config } from '../config';

export function plannedPortReach(): MeshPortReach[] {
  const role = roleNameFromFlags(config.roles);
  const live = portPlanLiveFromConfig();
  return portPlanForRole(role, live).map(specToReach);
}

function specToReach(spec: PortSpec): MeshPortReach {
  return {
    purpose: spec.purpose,
    proto: spec.proto,
    ...(spec.port !== undefined ? { port: spec.port } : {}),
    ...(spec.range ? { range: { begin: spec.range.begin, end: spec.range.end } } : {}),
    status: 'unknown',
    code: 'not_probed',
  };
}

function portPlanLiveFromConfig(): PortPlanLive {
  const role = roleNameFromFlags(config.roles);
  return {
    gatewayPort: config.port,
    gatewayExposed: !isLoopbackHostname(config.bindHost),
    peerPort: config.peerPort,
    rtcRange: config.rtcPortRange ?? defaultRtcPortRange(role),
    turnPort: config.turnPort,
    turnRelayRange: {
      begin: config.turnRelayPortRange.begin,
      end: config.turnRelayPortRange.end,
    },
    publicHttpsPort: publicHttpsPortFromConfig(),
  };
}

function publicHttpsPortFromConfig(): number | null {
  const raw = config.relayPublicUrl?.trim();
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
