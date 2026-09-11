import {
  type VibeTermRoleName,
  type VibeTermRoles,
  isStandaloneRoles,
  isVibeTermRoleName,
  roleNameFromFlags,
  rolesFromName,
  validateRoles,
} from '../../../../packages/shared/src/roles';
import { BUILTIN_STUN_SERVERS } from '../../../shared/src/net/stun-defaults';

export type { VibeTermRoleName, VibeTermRoles };
export { isStandaloneRoles, roleNameFromFlags, rolesFromName, validateRoles };

export const DEFAULT_PEER_PORT = 39001;
/** 仅用于帮助/展示；安装器不再把该值写入 app.env。 */
export const DEFAULT_STUN_SERVERS = BUILTIN_STUN_SERVERS.join(',');

export function parseVibeTermRoleName(raw: string | undefined): VibeTermRoleName {
  const value = (raw ?? 'standalone').trim();
  if (!isVibeTermRoleName(value)) {
    throw new Error('role must be one of standalone | node | hub,node | relay | relay,node');
  }
  return value;
}

export function parseVibeTermRoles(raw: string | undefined): VibeTermRoles {
  const name = parseVibeTermRoleName(raw === undefined || raw.trim() === '' ? 'standalone' : raw);
  return rolesFromName(name);
}
