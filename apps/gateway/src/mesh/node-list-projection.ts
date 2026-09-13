import { decodeCertificate, encodeBase64url } from '@vibeterm/shared/auth';
import type { MeshPortReachCode, PortPurpose } from '@vibeterm/shared/net';
import { hasNodeSessionCookie } from '../auth/cookies';
import { isPeerReachable } from './address-class';
import { MESH_VIA_SELF } from './mesh-deps';

type Meta = {
  endpoints?: unknown;
  inventory?: unknown;
  directCapable?: boolean;
  version?: string | null;
  peerReach?: Record<string, 'ok' | 'refused' | 'timeout'>;
};

export type MeshNodeDcBreaker = {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
};

/** 与 `peer-manager-types.ts` 的 `DirectFailureCode` 同步；此处按下发报文的形状写成字符串。 */
export type MeshNodeDirectFailure = {
  at: number;
  ws?: string | null;
  wsCode?: string | null;
  wsParams?: { url?: string; seconds?: number } | null;
  dc?: string | null;
  dcCode?: string | null;
  dcParams?: { until?: number } | null;
};

export type MeshNodeLinkDetail = {
  peerAddress: string | null;
  linkSinceAt: number | null;
  endpoints: string[];
  directFailure: MeshNodeDirectFailure | null;
  dcBreaker?: MeshNodeDcBreaker | null;
  viaRelay?: string | null;
  relayPresence?: string[];
};

export type MeshPortReach = {
  purpose: PortPurpose;
  proto: 'tcp' | 'udp';
  port?: number;
  range?: { begin: number; end: number };
  status: 'open' | 'blocked' | 'unknown';
  code?: MeshPortReachCode;
  checkedAt?: number;
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
  directFailure?: MeshNodeDirectFailure | null;
  dcBreaker?: MeshNodeDcBreaker | null;
  viaRelay?: string | null;
  relayPresence?: string[];
  /** `peer_cache.last_seen_at`（毫秒）；self 恒为 `null`。旧入口不下发。 */
  lastSeenAt?: number | null;
  /** 入口本机暂停了该成员时为 true；self 与未暂停行缺省。 */
  paused?: boolean;
  /** 入站口可达性；self 行也下发。旧入口无此字段。 */
  ports?: MeshPortReach[];
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
    ...((live?.peerReach ?? stored.peerReach)
      ? { peer_reach: live?.peerReach ?? stored.peerReach }
      : {}),
  };
}

export function upsertById<T extends { id: string }>(nodes: T[], entry: T): void {
  const existing = nodes.find((n) => n.id === entry.id);
  if (existing) Object.assign(existing, entry);
  else nodes.push(entry);
}

function usableMeshName(name: string | null | undefined, id: string): string | null {
  const t = name?.trim() ?? '';
  return !t || t === id || t === 'self' ? null : t;
}

/** 本机展示名：listed → hub `nodes` 行 → `node_identity.name` → 站点名。占位 `self` / 节点 id 一律跳过。 */
export function pickSelfDisplayName(input: {
  id: string;
  listedName?: string | null;
  registryName?: string | null;
  identityName?: string | null;
  siteName?: string | null;
}): string | null {
  return (
    usableMeshName(input.listedName, input.id) ??
    usableMeshName(input.registryName, input.id) ??
    usableMeshName(input.identityName, input.id) ??
    usableMeshName(input.siteName, input.id)
  );
}

export function pickMeshNodeName(input: {
  id: string;
  isSelf: boolean;
  listedName?: string | null;
  registryName?: string | null;
  selfName?: string | null;
}): string {
  return (
    usableMeshName(input.listedName, input.id) ??
    usableMeshName(input.registryName, input.id) ??
    (input.isSelf ? usableMeshName(input.selfName, input.id) : null) ??
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
): Pick<MeshNodeDto, 'peerAddress' | 'linkSinceAt' | 'endpoints' | 'directFailure' | 'dcBreaker'> {
  if (isSelf) {
    return {
      peerAddress: null,
      linkSinceAt: null,
      endpoints: [],
      directFailure: null,
      dcBreaker: null,
    };
  }
  return {
    peerAddress: detail?.peerAddress ?? null,
    linkSinceAt: detail?.linkSinceAt ?? null,
    endpoints: storedEndpoints,
    directFailure: detail?.directFailure ?? null,
    dcBreaker: detail?.dcBreaker ?? null,
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

function meshRelayFields(
  isSelf: boolean,
  id: string,
  transport: 'ws-secure' | 'relay' | 'dc' | null,
  detail: MeshNodeLinkDetail | null,
  viaRelayOf?: (id: string) => string | null,
  relayPresenceOf?: (id: string) => string[] | undefined
): Pick<MeshNodeDto, 'viaRelay' | 'relayPresence'> {
  if (isSelf) return {};
  const viaRelay = viaRelayOf?.(id) ?? detail?.viaRelay;
  const relayPresence = relayPresenceOf?.(id) ?? detail?.relayPresence;
  return {
    ...(transport === 'relay' ? { viaRelay: viaRelay ?? null } : {}),
    ...(relayPresence !== undefined ? { relayPresence } : {}),
  };
}

export function overlayPausedMeshNodes(
  nodes: MeshNodeDto[],
  selfId: string,
  pausedIds: ReadonlySet<string>
): MeshNodeDto[] {
  return nodes.map((node) => {
    if (node.id === selfId || !pausedIds.has(node.id)) return node;
    return { ...node, paused: true };
  });
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
    {
      inventoryJson?: string | null;
      directCapable?: boolean;
      endpointsJson?: string | null;
      lastSeenAt?: number | null;
    }
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
  attachedHubIdOf?: (id: string) => string | null | undefined,
  viaRelayOf?: (id: string) => string | null,
  relayPresenceOf?: (id: string) => string[] | undefined
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
    loggedIn: hasNodeSessionCookie(cookies, isSelf ? MESH_VIA_SELF : id),
    isHub: hubIds ? hubIds.has(id) : hubNodeId === id,
    ...(hubModeOf?.(id) ? { hubMode: hubModeOf(id) } : {}),
    ...(attachedHubIdOf?.(id) ? { attachedHubId: attachedHubIdOf(id) ?? undefined } : {}),
    ...meshLinkFields(isSelf, detail, endpointsFromJson(peer?.endpointsJson)),
    ...meshRelayFields(isSelf, id, path.transport, detail, viaRelayOf, relayPresenceOf),
    lastSeenAt: meshLastSeenAt(isSelf, peer?.lastSeenAt),
  };
}

function meshLastSeenAt(isSelf: boolean, lastSeenAt: number | null | undefined): number | null {
  if (isSelf) return null;
  return typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) ? lastSeenAt : null;
}

function endpointsFromJson(raw: string | null | undefined): string[] {
  const parsed = parseJson(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

/** `GET /api/mesh/nodes` 的列表同步进度。 */
export type MeshListReadiness = {
  /** 本地 `peer_cache` 见过的最高 `node.list` / `relay.list` 版本；一次都没应用过为 0。 */
  listVersion: number;
  /** 已 admit 但状态块还没解开的成员数（等于 `pendingMemberIds.length`）。 */
  pendingMembers: number;
  /** 上一条的成员 id：浏览器据此把已经在列表里的那几行就地画成占位。 */
  pendingMemberIds: string[];
};

type ReadinessStore = {
  listPeers(): ReadonlyArray<{ nodeId: string; listVersion: number }>;
  listCerts(): ReadonlyArray<{ nodeId: string; revokedLogSeq: number | null }>;
};

/**
 * 证书立刻就在，成员的名字 / inventory 却要等上级把状态块解开写进 `peer_cache`
 * （见 `relay-node-list.ts` 的 `entryFromCache` 兜底）。两者的差额就是「还在同步中的成员」，
 * 浏览器据此把「列表还没到齐」与「本来就只有一台」区分开。
 *
 * 判据必须收敛：状态块只随**活着的链路**广播，所以本进程已经应用过成员列表之后，列表里
 * 没有（已不在中继）或列表说它离线的成员就再也等不到状态块了——那几行按离线渲染，不再算
 * 同步中，否则节点表会永远停在骨架上。
 *
 * `listed` 为 `null` 才是「本进程还没应用过任何列表」（刚重启的那几秒），此时一律算同步中；
 * **空数组是已应用过的空列表**（中继列表不含本机，单节点租户就是这一档），本地残留的证书
 * 该按离线渲染而不是永远同步中。hub 自己就是成员集的权威，调用方直接把整份投影当 `listed`。
 */
export function meshListReadiness(
  store: ReadinessStore,
  selfNodeId: string,
  nodes: ReadonlyArray<{ id: string; online: boolean }>,
  listed: ReadonlyArray<{ id: string }> | null
): MeshListReadiness {
  const cached = new Set<string>();
  let listVersion = 0;
  for (const peer of store.listPeers()) {
    cached.add(peer.nodeId);
    if (peer.listVersion > listVersion) listVersion = peer.listVersion;
  }
  const listedIds = listed === null ? null : new Set(listed.map((row) => row.id));
  const onlineIds = new Set(nodes.filter((node) => node.online).map((node) => node.id));
  const pendingMemberIds: string[] = [];
  for (const cert of store.listCerts()) {
    if (cert.revokedLogSeq != null) continue;
    if (cert.nodeId === selfNodeId) continue;
    if (cached.has(cert.nodeId)) continue;
    if (listedIds !== null && (!listedIds.has(cert.nodeId) || !onlineIds.has(cert.nodeId))) {
      continue;
    }
    pendingMemberIds.push(cert.nodeId);
  }
  return { listVersion, pendingMembers: pendingMemberIds.length, pendingMemberIds };
}
