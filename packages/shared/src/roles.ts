export type TmexRoleName = 'standalone' | 'node' | 'hub,node' | 'relay' | 'relay,node';

export type TmexRoles = { hub: boolean; node: boolean; relay: boolean };

export const TMEX_ROLE_NAMES: readonly TmexRoleName[] = [
  'standalone',
  'node',
  'hub,node',
  'relay',
  'relay,node',
];

export function isTmexRoleName(value: string): value is TmexRoleName {
  return (TMEX_ROLE_NAMES as readonly string[]).includes(value);
}

export function rolesFromName(name: TmexRoleName): TmexRoles {
  if (name === 'node') return { hub: false, node: true, relay: false };
  if (name === 'hub,node') return { hub: true, node: true, relay: false };
  if (name === 'relay') return { hub: false, node: false, relay: true };
  if (name === 'relay,node') return { hub: false, node: true, relay: true };
  return { hub: false, node: false, relay: false };
}

export function isStandaloneRoles(roles: TmexRoles): boolean {
  return !roles.hub && !roles.node && !roles.relay;
}

export function roleNameFromFlags(roles: TmexRoles): TmexRoleName {
  if (roles.relay) return roles.node ? 'relay,node' : 'relay';
  if (roles.hub && roles.node) return 'hub,node';
  if (roles.node) return 'node';
  return 'standalone';
}

/** 中继与 hub 不能同机：两者都要抢 uplink 服务端角色，且中继不应持有租户明文。 */
export function validateRoles(roles: TmexRoles): string | null {
  if (roles.hub && roles.relay) {
    return 'relay cannot be combined with hub';
  }
  return null;
}
