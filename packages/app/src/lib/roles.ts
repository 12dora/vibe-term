import {
  type VibeTermRoleName,
  type VibeTermRoles,
  isStandaloneRoles,
  isVibeTermRoleName,
  normalizeLegacyRoleName,
  roleNameFromFlags,
  rolesFromName,
} from '../../../../packages/shared/src/roles';

export type { VibeTermRoleName, VibeTermRoles };
export { isStandaloneRoles, roleNameFromFlags, rolesFromName };
export { DEFAULT_PEER_PORT } from '../../../shared/src/net';

const ROLE_ERROR = 'VIBETERM_ROLES must be one of standalone | node | relay | relay,node';

let warnedLegacyHubNode = false;

export function parseVibeTermRoleName(raw: string | undefined): VibeTermRoleName {
  const { name, legacy } = normalizeLegacyRoleName(raw ?? 'standalone');
  if (legacy && !warnedLegacyHubNode) {
    warnedLegacyHubNode = true;
    console.warn('[roles] VIBETERM_ROLES=hub,node is no longer supported; running as node');
  }
  if (!isVibeTermRoleName(name)) {
    throw new Error(ROLE_ERROR);
  }
  return name;
}

export function parseVibeTermRoles(raw: string | undefined): VibeTermRoles {
  const name = parseVibeTermRoleName(raw === undefined || raw.trim() === '' ? 'standalone' : raw);
  return rolesFromName(name);
}
