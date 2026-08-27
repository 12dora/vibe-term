export type TmexRoleName = 'standalone' | 'node' | 'hub,node';

export type TmexRoles = { hub: boolean; node: boolean };

export const DEFAULT_PEER_PORT = 39001;
export const DEFAULT_STUN_SERVERS = 'stun:stun.l.google.com:19302';

export function parseTmexRoleName(raw: string | undefined): TmexRoleName {
  const value = (raw ?? 'standalone').trim();
  if (value === 'standalone' || value === 'node' || value === 'hub,node') {
    return value;
  }
  throw new Error('role must be one of standalone | node | hub,node');
}

export function parseTmexRoles(raw: string | undefined): TmexRoles {
  const name = parseTmexRoleName(raw === undefined || raw.trim() === '' ? 'standalone' : raw);
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
