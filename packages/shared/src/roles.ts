export type TmexRoleName = 'standalone' | 'node' | 'hub,node';

export type TmexRoles = { hub: boolean; node: boolean };

export function isTmexRoleName(value: string): value is TmexRoleName {
  return value === 'standalone' || value === 'node' || value === 'hub,node';
}

export function rolesFromName(name: TmexRoleName): TmexRoles {
  if (name === 'standalone') return { hub: false, node: false };
  if (name === 'node') return { hub: false, node: true };
  return { hub: true, node: true };
}

export function isStandaloneRoles(roles: TmexRoles): boolean {
  return !roles.hub && !roles.node;
}

export function roleNameFromFlags(roles: TmexRoles): TmexRoleName {
  if (roles.hub && roles.node) return 'hub,node';
  if (roles.node) return 'node';
  return 'standalone';
}
