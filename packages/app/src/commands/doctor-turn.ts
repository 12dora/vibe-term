import { probeStunServer } from '../../../../apps/gateway/src/mesh/rtc/stun-probe';
import {
  DEFAULT_TURN_PORT,
  decideTurnMode,
  parseTurnPort,
  parseTurnRelayPortRange,
  turnFirewallHint,
} from '../../../../apps/gateway/src/relay/relay-turn-config';
import {
  parseTurnBindHost,
  resolveTurnListenHost,
} from '../../../../apps/gateway/src/relay/turn/local-address';
import { t } from '../i18n';
import { parseVibeTermRoles } from '../lib/roles';
import type { DoctorCheck } from '../types';

export type RelayTurnDoctorProbe = (url: string) => Promise<{ ok: boolean }>;
export type RelayTurnDoctorResolveBind = (spec: string) => Promise<string>;

function envRolesAreRelay(env: Record<string, string>): boolean {
  try {
    return parseVibeTermRoles(env.VIBETERM_ROLES).relay;
  } catch {
    return false;
  }
}

export async function relayTurnDoctorCheck(
  env: Record<string, string>,
  probe: RelayTurnDoctorProbe = (url) => probeStunServer(url),
  resolveBind: RelayTurnDoctorResolveBind = (spec) => resolveTurnListenHost(spec)
): Promise<DoctorCheck | null> {
  if (!envRolesAreRelay(env)) return null;
  const turnPort = parseTurnPort(env.VIBETERM_TURN_PORT);
  const range = parseTurnRelayPortRange(env.VIBETERM_TURN_RELAY_PORT_RANGE);
  const mode = decideTurnMode({
    turnUrl: env.VIBETERM_TURN_URL?.trim() || null,
    turnUsername: env.VIBETERM_TURN_USERNAME?.trim() || null,
    turnCredential: env.VIBETERM_TURN_CREDENTIAL?.trim() || null,
    turnPort,
  });
  const hintPort = mode === 'off' || turnPort === 0 ? DEFAULT_TURN_PORT : turnPort;
  const firewall = turnFirewallHint(hintPort, `${range.begin}-${range.end}`);
  if (mode === 'external') {
    return {
      id: 'turn',
      level: 'pass',
      message: t('doctor.turn.external'),
      detail: firewall,
    };
  }
  if (mode === 'off') {
    return {
      id: 'turn',
      level: 'pass',
      message: t('doctor.turn.off'),
      detail: firewall,
    };
  }
  const spec = parseTurnBindHost(env.VIBETERM_TURN_BIND_HOST);
  const resolved = await resolveBind(spec);
  const bind = spec === 'auto' ? `${resolved} (auto)` : resolved;
  // 绑定到具体地址失败时服务会回退到 0.0.0.0，所以具体地址探不到再探回环，避免误报未监听
  const probeHosts = resolved === '0.0.0.0' ? ['127.0.0.1'] : [resolved, '127.0.0.1'];
  let bound = false;
  for (const host of probeHosts) {
    bound = await probe(`stun:${host}:${turnPort}`)
      .then((result) => result.ok)
      .catch(() => false);
    if (bound) break;
  }
  return {
    id: 'turn',
    level: bound ? 'pass' : 'warn',
    message: t(bound ? 'doctor.turn.builtinListening' : 'doctor.turn.builtinNotListening', {
      port: turnPort,
      bind,
    }),
    detail: firewall,
  };
}
