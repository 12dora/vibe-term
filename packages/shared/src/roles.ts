export type VibeTermRoleName = 'standalone' | 'node' | 'hub,node' | 'relay' | 'relay,node';

export type VibeTermRoles = { hub: boolean; node: boolean; relay: boolean };

export const VIBETERM_ROLE_NAMES: readonly VibeTermRoleName[] = [
  'standalone',
  'node',
  'hub,node',
  'relay',
  'relay,node',
];

export function isVibeTermRoleName(value: string): value is VibeTermRoleName {
  return (VIBETERM_ROLE_NAMES as readonly string[]).includes(value);
}

export function rolesFromName(name: VibeTermRoleName): VibeTermRoles {
  if (name === 'node') return { hub: false, node: true, relay: false };
  if (name === 'hub,node') return { hub: true, node: true, relay: false };
  if (name === 'relay') return { hub: false, node: false, relay: true };
  if (name === 'relay,node') return { hub: false, node: true, relay: true };
  return { hub: false, node: false, relay: false };
}

export function isStandaloneRoles(roles: VibeTermRoles): boolean {
  return !roles.hub && !roles.node && !roles.relay;
}

export function roleNameFromFlags(roles: VibeTermRoles): VibeTermRoleName {
  if (roles.relay) return roles.node ? 'relay,node' : 'relay';
  if (roles.hub && roles.node) return 'hub,node';
  if (roles.node) return 'node';
  return 'standalone';
}

/** 中继与 hub 不能同机：两者都要抢 uplink 服务端角色，且中继不应持有租户明文。 */
export function validateRoles(roles: VibeTermRoles): string | null {
  if (roles.hub && roles.relay) {
    return 'relay cannot be combined with hub';
  }
  return null;
}
