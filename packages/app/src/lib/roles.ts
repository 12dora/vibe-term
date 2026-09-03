import {
  type TmexRoleName,
  type TmexRoles,
  isStandaloneRoles,
  isTmexRoleName,
  roleNameFromFlags,
  rolesFromName,
  validateRoles,
} from '../../../../packages/shared/src/roles';

export type { TmexRoleName, TmexRoles };
export { isStandaloneRoles, roleNameFromFlags, rolesFromName, validateRoles };

export const DEFAULT_PEER_PORT = 39001;
export const DEFAULT_STUN_SERVERS = 'stun:stun.l.google.com:19302';

export function parseTmexRoleName(raw: string | undefined): TmexRoleName {
  const value = (raw ?? 'standalone').trim();
  if (!isTmexRoleName(value)) {
    throw new Error('role must be one of standalone | node | hub,node | relay | relay,node');
  }
  return value;
}

export function parseTmexRoles(raw: string | undefined): TmexRoles {
  const name = parseTmexRoleName(raw === undefined || raw.trim() === '' ? 'standalone' : raw);
  return rolesFromName(name);
}
