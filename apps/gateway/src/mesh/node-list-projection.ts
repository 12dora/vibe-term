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

export type MeshNodeLinkDetail = {
  peerAddress: string | null;
  linkSinceAt: number | null;
  endpoints: string[];
  directFailure: { at: number; ws?: string | null; dc?: string | null } | null;
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
  hubMode?: 'active' | 'standby';
  attachedHubId?: string;
  peerAddress?: string | null;
  linkSinceAt?: number | null;
  endpoints?: string[];
  directFailure?: { at: number; ws?: string | null; dc?: string | null } | null;
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
  live?: Meta | null,
  attachedHubId?: string | null
) {
  return {
    id,
    name,
    online,
    endpoints: live?.endpoints ?? stored.endpoints ?? [],
    inventory: live?.inventory ?? stored.inventory ?? null,
    direct_capable: live?.directCapable ?? stored.directCapable ?? false,
    version: live?.version ?? stored.version ?? null,
    ...(attachedHubId ? { attachedHubId } : {}),
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

function publicKeyForMeshNode(
  id: string,
  selfId: string,
  selfPk: Uint8Array,
  certById: Map<string, { certificateBytes: Uint8Array }>
): Uint8Array | null {
  if (id === selfId) return selfPk;
  const cert = certById.get(id);
  if (!cert) return null;
  try {
    return decodeCertificate(cert.certificateBytes).ed_pk;
  } catch {
    return null;
  }
}

function selfStatusOverlay(
  isSelf: boolean,
  self: { inventory?: unknown; direct_capable: boolean; version?: string } | undefined
): Meta | null {
  if (!isSelf || !self) return null;
  return {
    inventory: self.inventory,
    directCapable: self.direct_capable,
    version: self.version || undefined,
  };
}

function meshLinkFields(
  isSelf: boolean,
  detail: MeshNodeLinkDetail | null | undefined,
  storedEndpoints: string[]
): Pick<MeshNodeDto, 'peerAddress' | 'linkSinceAt' | 'endpoints' | 'directFailure'> {
  if (isSelf) {
    return { peerAddress: null, linkSinceAt: null, endpoints: [], directFailure: null };
  }
  return {
    peerAddress: detail?.peerAddress ?? null,
    linkSinceAt: detail?.linkSinceAt ?? null,
    endpoints: storedEndpoints,
    directFailure: detail?.directFailure ?? null,
  };
}

function meshPathFields(
  isSelf: boolean,
  id: string,
  transportOf?: (id: string) => 'ws-secure' | 'relay' | 'dc' | null,
  rttOf?: (id: string) => number | null
): { transport: 'ws-secure' | 'relay' | 'dc' | null; rttMs: number | null } {
  if (isSelf) return { transport: null, rttMs: null };
  return { transport: transportOf?.(id) ?? null, rttMs: rttOf?.(id) ?? null };
}

export function projectMeshListNode(
  id: string,
  selfId: string,
  selfPk: Uint8Array,
  cookies: Map<string, string>,
  reach: Map<string, 'lan' | 'wan' | 'relay' | null>,
  hubOnline: ReadonlySet<string>,
  certById: Map<string, { certificateBytes: Uint8Array }>,
  peerById: Map<
    string,
    { inventoryJson?: string | null; directCapable?: boolean; endpointsJson?: string | null }
  >,
  listedById: Map<string, string>,
  registryById: Map<string, string>,
  selfName: string | null,
  self: { inventory?: unknown; direct_capable: boolean; version?: string } | undefined,
  hubNodeId: string | null,
  transportOf?: (id: string) => 'ws-secure' | 'relay' | 'dc' | null,
  rttOf?: (id: string) => number | null,
  linkDetailOf?: (id: string) => MeshNodeLinkDetail | null,
  hubIds?: ReadonlySet<string>,
  hubModeOf?: (id: string) => 'active' | 'standby' | undefined,
  attachedHubIdOf?: (id: string) => string | null | undefined
): MeshNodeDto | null {
  const publicKey = publicKeyForMeshNode(id, selfId, selfPk, certById);
  if (!publicKey) return null;
  const isSelf = id === selfId;
  const peer = peerById.get(id);
  const r = reach.get(id) ?? null;
  const inv = parseJson(peer?.inventoryJson, peer?.inventoryJson ?? null);
  const detail = isSelf ? null : (linkDetailOf?.(id) ?? null);
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
    selfStatusOverlay(isSelf, self)
  );
  const path = meshPathFields(isSelf, id, transportOf, rttOf);
  return {
    id,
    name: core.name,
    publicKey: encodeBase64url(publicKey),
    online: core.online,
    reach: r,
    transport: path.transport,
    rttMs: path.rttMs,
    version: core.version || versionFromInventory(core.inventory),
    direct_capable: core.direct_capable,
    inventory: core.inventory,
    loggedIn: cookies.has(nodeSessionCookieName(isSelf ? MESH_VIA_SELF : id)),
    isHub: hubIds ? hubIds.has(id) : hubNodeId === id,
    ...(hubModeOf?.(id) ? { hubMode: hubModeOf(id) } : {}),
    ...(attachedHubIdOf?.(id) ? { attachedHubId: attachedHubIdOf(id) ?? undefined } : {}),
    ...meshLinkFields(isSelf, detail, endpointsFromJson(peer?.endpointsJson)),
  };
}

function endpointsFromJson(raw: string | null | undefined): string[] {
  const parsed = parseJson(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}
