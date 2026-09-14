export type VibeTermRoleName = 'standalone' | 'node' | 'relay' | 'relay,node';

export type VibeTermRoles = { node: boolean; relay: boolean };

export const VIBETERM_ROLE_NAMES: readonly VibeTermRoleName[] = [
  'standalone',
  'node',
  'relay',
  'relay,node',
];

export function isVibeTermRoleName(value: string): value is VibeTermRoleName {
  return (VIBETERM_ROLE_NAMES as readonly string[]).includes(value);
}

/** `hub,node` 已删除：trim 后映射为 `node`（`legacy: true`）；其余原样返回。 */
export function normalizeLegacyRoleName(raw: string): { name: string; legacy: boolean } {
  const name = raw.trim();
  if (name === 'hub,node') return { name: 'node', legacy: true };
  return { name, legacy: false };
}

export function rolesFromName(name: VibeTermRoleName): VibeTermRoles {
  if (name === 'node') return { node: true, relay: false };
  if (name === 'relay') return { node: false, relay: true };
  if (name === 'relay,node') return { node: true, relay: true };
  return { node: false, relay: false };
}

export function isStandaloneRoles(roles: VibeTermRoles): boolean {
  return !roles.node && !roles.relay;
}

export function roleNameFromFlags(roles: VibeTermRoles): VibeTermRoleName {
  if (roles.relay) return roles.node ? 'relay,node' : 'relay';
  if (roles.node) return 'node';
  return 'standalone';
}
