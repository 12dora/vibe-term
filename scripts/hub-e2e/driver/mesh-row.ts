export const MESH_TRANSPORTS = ['ws-secure', 'relay', 'dc'] as const;
export type MeshTransport = (typeof MESH_TRANSPORTS)[number];

export type MeshNodeRow = {
  id: string;
  name: string;
  online: boolean;
  reach: 'lan' | 'relay' | null;
  transport: MeshTransport | null;
  direct_capable: boolean;
  isHub?: boolean;
};

export function isMeshTransport(value: string): value is MeshTransport {
  return (MESH_TRANSPORTS as readonly string[]).includes(value);
}

export function findByName<T extends { name: string; id?: string }>(
  nodes: T[],
  name: string
): T | undefined {
  return nodes.find((n) => n.name === name || n.id === name);
}

export function matchesTransport(
  row: { online?: boolean; transport?: string | null } | undefined,
  transport: string
): boolean {
  return row?.online === true && row.transport === transport;
}
