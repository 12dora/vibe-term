import { probeStunServer } from '../../../../apps/gateway/src/mesh/rtc/stun-probe';
import {
  DEFAULT_TURN_PORT,
  decideTurnMode,
  parseTurnPort,
  parseTurnRelayPortRange,
  turnFirewallHint,
} from '../../../../apps/gateway/src/relay/relay-turn-config';
import { t } from '../i18n';
import { parseVibeTermRoles } from '../lib/roles';
import type { DoctorCheck } from '../types';

export type RelayTurnDoctorProbe = (url: string) => Promise<{ ok: boolean }>;

function envRolesAreRelay(env: Record<string, string>): boolean {
  try {
    return parseVibeTermRoles(env.VIBETERM_ROLES).relay;
  } catch {
    return false;
  }
}

export async function relayTurnDoctorCheck(
  env: Record<string, string>,
  probe: RelayTurnDoctorProbe = (url) => probeStunServer(url)
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
  const bound = await probe(`stun:127.0.0.1:${turnPort}`)
    .then((result) => result.ok)
    .catch(() => false);
  return {
    id: 'turn',
    level: bound ? 'pass' : 'warn',
    message: t(bound ? 'doctor.turn.builtinListening' : 'doctor.turn.builtinNotListening', {
      port: turnPort,
    }),
    detail: firewall,
  };
}
