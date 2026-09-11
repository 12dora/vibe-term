import {
  type VibeTermRoleName,
  type VibeTermRoles,
  isStandaloneRoles,
  isVibeTermRoleName,
  roleNameFromFlags,
  rolesFromName,
  validateRoles,
} from '../../../../packages/shared/src/roles';

export type { VibeTermRoleName, VibeTermRoles };
export { isStandaloneRoles, roleNameFromFlags, rolesFromName, validateRoles };

export const DEFAULT_PEER_PORT = 39001;

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
