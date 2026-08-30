import { decodeCertificate, encodeBase64url } from '@tmex/shared/auth';
import { nodeSessionCookieName } from '../auth/cookies';
import { isPeerReachable } from './address-class';
import { MESH_VIA_SELF } from './mesh-deps';

type Meta = {
  endpoints?: unknown;
  inventory?: unknown;
  directCapable?: boolean;
  version?: string | null;
};

export type MeshNodeDto = {
  id: string;
  name: string;
  publicKey: string;
  online: boolean;
  reach: 'lan' | 'wan' | 'relay' | null;
  transport: 'ws-secure' | 'relay' | 'dc' | null;
  rttMs: number | null;
  version: string | null;
  direct_capable: boolean;
  inventory: unknown;
  loggedIn: boolean;
  isHub: boolean;
};

export function parseJson(raw: string | null | undefined, fallback: unknown): unknown {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function versionFromInventory(inventory: unknown): string | null {
  if (!inventory || typeof inventory !== 'object' || !('version' in inventory)) return null;
  const value = (inventory as { version: unknown }).version;
  return value == null ? null : String(value);
}

export function projectNode(
  id: string,
  name: string,
  online: boolean,
  stored: Meta,
  live?: Meta | null
) {
  return {
    id,
    name,
    online,
    endpoints: live?.endpoints ?? stored.endpoints ?? [],
    inventory: live?.inventory ?? stored.inventory ?? null,
    direct_capable: live?.directCapable ?? stored.directCapable ?? false,
    version: live?.version ?? stored.version ?? null,
  };
}

export function upsertById<T extends { id: string }>(nodes: T[], entry: T): void {
  const existing = nodes.find((n) => n.id === entry.id);
  if (existing) Object.assign(existing, entry);
  else nodes.push(entry);
}

export function pickMeshNodeName(input: {
  id: string;
  isSelf: boolean;
  listedName?: string | null;
  registryName?: string | null;
  selfName?: string | null;
}): string {
  const usable = (name: string | null | undefined) => {
    const t = name?.trim() ?? '';
    return !t || t === input.id || t === 'self' ? null : t;
  };
  return (
    usable(input.listedName) ??
    usable(input.registryName) ??
    (input.isSelf ? usable(input.selfName) : null) ??
    (input.isSelf ? input.selfName?.trim() || 'self' : input.id)
  );
}

export function projectMeshListNode(
  id: string,
  selfId: string,
  selfPk: Uint8Array,
  cookies: Map<string, string>,
  reach: Map<string, 'lan' | 'wan' | 'relay' | null>,
  hubOnline: ReadonlySet<string>,
  certById: Map<string, { certificateBytes: Uint8Array }>,
  peerById: Map<string, { inventoryJson?: string | null; directCapable?: boolean }>,
  listedById: Map<string, string>,
  registryById: Map<string, string>,
  selfName: string | null,
  self: { inventory?: unknown; direct_capable: boolean; version?: string } | undefined,
  hubNodeId: string | null,
  transportOf?: (id: string) => 'ws-secure' | 'relay' | 'dc' | null,
  rttOf?: (id: string) => number | null
): MeshNodeDto | null {
  const isSelf = id === selfId;
  const cert = certById.get(id);
  let publicKey: Uint8Array | null = isSelf ? selfPk : null;
  if (!isSelf) {
    if (!cert) return null;
    try {
      publicKey = decodeCertificate(cert.certificateBytes).ed_pk;
    } catch {
      return null;
    }
  }
  const peer = peerById.get(id);
  if (!publicKey) return null;
  const r = reach.get(id) ?? null;
  const inv = parseJson(peer?.inventoryJson, peer?.inventoryJson ?? null);
  const core = projectNode(
    id,
    pickMeshNodeName({
      id,
      isSelf,
      listedName: listedById.get(id),
      registryName: registryById.get(id),
      selfName,
    }),
    isSelf || hubOnline.has(id) || isPeerReachable(r),
    {
      inventory: inv,
      directCapable: peer?.directCapable ?? false,
      version: versionFromInventory(inv),
    },
    isSelf && self
      ? {
          inventory: self.inventory,
          directCapable: self.direct_capable,
          version: self.version || undefined,
        }
      : null
  );
  return {
    id,
    name: core.name,
    publicKey: encodeBase64url(publicKey),
    online: core.online,
    reach: r,
    transport: isSelf ? null : (transportOf?.(id) ?? null),
    rttMs: isSelf ? null : (rttOf?.(id) ?? null),
    version: core.version || versionFromInventory(core.inventory),
    direct_capable: core.direct_capable,
    inventory: core.inventory,
    loggedIn: cookies.has(nodeSessionCookieName(isSelf ? MESH_VIA_SELF : id)),
    isHub: hubNodeId === id,
  };
}
