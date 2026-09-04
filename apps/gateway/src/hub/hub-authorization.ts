import { compareSemver } from '@tmex/shared';
import {
  KEYLOG_RECORD_COMPAT,
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_HUB_AUTH_RECORD_VERSION,
  RELAY_RECORD_TYPES,
  RENAME_NODE_RECORD_TYPES,
  decodeAdmitHubPayload,
  decodeKeyLogRecord,
  decodeRetireHubPayload,
  decodeRevokeNodePayload,
  nodeIdToHex,
} from '@tmex/shared/auth';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import { HUB_META_PEER_ID, type UserStore } from '../auth/user-store';

export type HubAuthorizationSource = 'signed-active' | 'signed-retired' | 'env' | 'self' | 'none';
export type HubAuthListColumn = 'signed' | 'env' | 'self' | 'no';
export type HubHttpAuthorization = 'signed' | 'env' | 'self' | 'none';

export type SignedHubAuthorization = { status: 'active' | 'retired' };

export type ResolveHubAuthorizationInput = {
  hubNodeId: string;
  selfId?: string | null;
  envPeers: Iterable<string>;
  signed: SignedHubAuthorization | null;
};

const HUB_NODE_ID_HEX = /^[0-9a-f]{32}$/;

export function normalizeHubNodeId(id: string): string {
  return id.trim().toLowerCase();
}

export function envPeerSet(ids: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!ids) return out;
  for (const raw of ids) {
    const value = normalizeHubNodeId(raw);
    if (HUB_NODE_ID_HEX.test(value)) out.add(value);
  }
  return out;
}

export function resolveHubAuthorization(
  input: ResolveHubAuthorizationInput
): HubAuthorizationSource {
  const id = normalizeHubNodeId(input.hubNodeId);
  if (input.signed?.status === 'active') return 'signed-active';
  if (input.signed?.status === 'retired') return 'signed-retired';
  const self = input.selfId ? normalizeHubNodeId(input.selfId) : '';
  if (self && id === self) return 'self';
  const peers = input.envPeers instanceof Set ? input.envPeers : envPeerSet(input.envPeers);
  if (peers.has(id)) return 'env';
  return 'none';
}

export function isAuthorizedHub(input: ResolveHubAuthorizationInput): boolean {
  const source = resolveHubAuthorization(input);
  return source === 'signed-active' || source === 'env' || source === 'self';
}

export function filterAuthorizedHubRecords<T extends { hubNodeId: string }>(
  rows: T[],
  opts: { userStore: UserStore; selfId?: string | null; envPeers: Iterable<string> }
): T[] {
  const uid = resolveMeshUserId(opts.userStore, { nodeId: opts.selfId });
  return rows.filter((row) =>
    isAuthorizedHub({
      hubNodeId: row.hubNodeId,
      selfId: opts.selfId,
      envPeers: opts.envPeers,
      signed: lookupSignedHubAuthorization(opts.userStore, uid, row.hubNodeId),
    })
  );
}

export function isSignedRetiredHub(
  userStore: UserStore,
  userId: string | null | undefined,
  hubNodeId: string
): boolean {
  return lookupSignedHubAuthorization(userStore, userId, hubNodeId)?.status === 'retired';
}

export function filterNotRetiredHubRecords<T extends { hubNodeId: string }>(
  rows: T[],
  opts: { userStore: UserStore; selfId?: string | null }
): T[] {
  const uid = resolveMeshUserId(opts.userStore, { nodeId: opts.selfId });
  return rows.filter((row) => !isSignedRetiredHub(opts.userStore, uid, row.hubNodeId));
}

export function hubAuthListColumn(source: HubAuthorizationSource): HubAuthListColumn {
  if (source === 'signed-active') return 'signed';
  if (source === 'env') return 'env';
  if (source === 'self') return 'self';
  return 'no';
}

export function hubHttpAuthorization(source: HubAuthorizationSource): HubHttpAuthorization {
  if (source === 'signed-active') return 'signed';
  if (source === 'env') return 'env';
  if (source === 'self') return 'self';
  // 未授权（含 signed-retired）：显式 'none'，让前端能把「需先签授权」与「旧入口没有该字段」区分开。
  return 'none';
}

export function lookupSignedHubAuthorization(
  userStore: UserStore,
  userId: string | null | undefined,
  hubNodeId: string
): SignedHubAuthorization | null {
  if (!userId) return null;
  const row = userStore.getHubAuthorization(userId, normalizeHubNodeId(hubNodeId));
  if (!row) return null;
  return { status: row.status };
}

export function resolveMeshUserId(
  userStore: UserStore,
  opts?: { nodeId?: string | null; explicit?: string | null }
): string | null {
  if (opts?.explicit) return opts.explicit;
  if (opts?.nodeId) {
    const cert = userStore.getCert(opts.nodeId);
    if (cert?.userId) return cert.userId;
    const node = userStore.getNode(opts.nodeId);
    if (node?.userId) return node.userId;
  }
  const ids = new Set<string>();
  for (const user of userStore.listUsers()) {
    if (user.id) ids.add(user.id);
  }
  if (ids.size !== 1) {
    for (const cert of userStore.listCerts()) {
      if (cert.userId) ids.add(cert.userId);
    }
  }
  if (ids.size !== 1) return null;
  const only = ids.values().next().value;
  return typeof only === 'string' && only.length > 0 ? only : null;
}

export type UnsupportedKeyLogNode = { id: string; name: string; version: string | null };

export type HubAuthRecordCompatResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof KEYLOG_TYPE_UNSUPPORTED_BY_NODES;
      minVersion: string;
      nodes: UnsupportedKeyLogNode[];
      allowForce: boolean;
    };

export type HubAuthCompatOptions = {
  relayMode?: boolean;
  /** 本机节点编号：本机版本即当前版本，永不阻塞。 */
  localNodeId?: string | null;
};

/** 节点侧记录：中继两类 + rename-node。空 peer cache 时仅这三类可 bootstrap 豁免。 */
function isNodeSideRecordType(type: string): boolean {
  return (
    (RELAY_RECORD_TYPES as readonly string[]).includes(type) ||
    (RENAME_NODE_RECORD_TYPES as readonly string[]).includes(type)
  );
}

function listActivePeers(userStore: UserStore) {
  return userStore.listPeers().filter((peer) => peer.nodeId !== HUB_META_PEER_ID);
}

function lookupCompatNode(
  userStore: UserStore,
  nodeId: string,
  relayMode: boolean
): { name: string; version: string | null; cached: boolean } {
  if (!relayMode) {
    const node = userStore.getNode(nodeId);
    if (node) return { name: node.name ?? nodeId, version: node.version ?? null, cached: true };
  }
  const peer = userStore.getPeer(nodeId);
  if (!peer) return { name: nodeId, version: null, cached: false };
  return { name: peer.name, version: peer.version, cached: true };
}

function hasKnownMembers(userStore: UserStore, relayMode: boolean): boolean {
  if (listActivePeers(userStore).length > 0) return true;
  return !relayMode && userStore.listNodes().length > 0;
}

export function normalizeReportedNodeVersion(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/_dev$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

export function nodeVersionMeets(raw: string | null | undefined, minVersion: string): boolean {
  const version = normalizeReportedNodeVersion(raw);
  if (!version) return false;
  const cmp = compareSemver(version, minVersion);
  return cmp !== null && cmp >= 0;
}

export function nodeVersionSupportsHubAuthRecords(raw: string | null | undefined): boolean {
  return nodeVersionMeets(raw, MIN_HUB_AUTH_RECORD_VERSION);
}

export function nodesBlockingMinVersion(
  userStore: UserStore,
  minVersion: string,
  userId?: string | null,
  opts?: HubAuthCompatOptions
): UnsupportedKeyLogNode[] {
  const relayMode = opts?.relayMode === true;
  const skipUncached = hasKnownMembers(userStore, relayMode);
  const blocked: UnsupportedKeyLogNode[] = [];
  const certs = userId ? userStore.listCertsByUser(userId) : userStore.listCerts();
  for (const cert of certs) {
    if (cert.revokedLogSeq != null || cert.nodeId === opts?.localNodeId) continue;
    const looked = lookupCompatNode(userStore, cert.nodeId, relayMode);
    if (skipUncached && !looked.cached) continue;
    if (nodeVersionMeets(looked.version, minVersion)) continue;
    blocked.push({
      id: cert.nodeId,
      name: looked.name,
      version: looked.version,
    });
  }
  return blocked;
}

export function inspectHubAuthRecordCompat(
  userStore: UserStore,
  recordBytes: Uint8Array,
  userId?: string | null,
  opts?: HubAuthCompatOptions
): HubAuthRecordCompatResult {
  let type: string;
  try {
    type = decodeKeyLogRecord(recordBytes).type;
  } catch {
    return { ok: true };
  }
  const spec = KEYLOG_RECORD_COMPAT[type as keyof typeof KEYLOG_RECORD_COMPAT];
  if (!spec) return { ok: true };
  const relayMode = opts?.relayMode === true;
  // 版本来源：hub 侧 nodes.version，纯节点与中继模式退到 peer_cache.version；
  // 尚无任何已知成员时只豁免节点侧三类记录（首台 bootstrap），hub-auth 与 rotate-root-keep 仍 fail-closed。
  if (isNodeSideRecordType(type) && !hasKnownMembers(userStore, relayMode)) {
    return { ok: true };
  }
  const nodes = nodesBlockingMinVersion(userStore, spec.minVersion, userId, opts);
  if (nodes.length === 0) return { ok: true };
  return {
    ok: false,
    code: KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
    minVersion: spec.minVersion,
    nodes,
    allowForce: spec.allowForce,
  };
}

/** `x-tmex-force-keylog` 仅对 allowForce 的记录类型生效；`rotate-root-keep` 不可绕过。 */
export function applyForcedKeyLogCompat(
  compat: HubAuthRecordCompatResult,
  forced: boolean
): HubAuthRecordCompatResult {
  if (compat.ok) return compat;
  if (!forced || !compat.allowForce) return compat;
  console.warn(
    `[auth] forcing key-log append despite ${compat.code} minVersion=${compat.minVersion} nodes=${compat.nodes
      .map((n) => n.id)
      .join(',')}`
  );
  return { ok: true };
}

export function applyKeyLogHubRuntime(
  meshHubs: MeshHubStore,
  record: { type: string; payload: Uint8Array },
  opts: {
    selfId?: string | null;
    now: number;
    onRetireSelf?: () => void;
  }
): void {
  const self = opts.selfId ? normalizeHubNodeId(opts.selfId) : '';
  if (record.type === 'admit-hub') {
    let payload: ReturnType<typeof decodeAdmitHubPayload>;
    try {
      payload = decodeAdmitHubPayload(record.payload);
    } catch {
      return;
    }
    const hex = nodeIdToHex(payload.hub_node_id);
    const existing = meshHubs.get(hex);
    const publicUrl = payload.public_url ?? existing?.publicUrl ?? null;
    if (!publicUrl) return;
    meshHubs.upsert(
      {
        hubNodeId: hex,
        publicUrl,
        name: existing?.name ?? null,
        mode: existing?.mode ?? 'standby',
        priority: payload.priority ?? existing?.priority ?? 200,
        writerEpoch: existing?.writerEpoch ?? 1,
        caFingerprint: existing?.caFingerprint ?? null,
        online: existing?.online ?? false,
        lastSeenAt: existing?.lastSeenAt ?? null,
      },
      opts.now
    );
    return;
  }
  if (record.type === 'retire-hub' || record.type === 'revoke-node') {
    let hex: string;
    try {
      hex =
        record.type === 'retire-hub'
          ? nodeIdToHex(decodeRetireHubPayload(record.payload).hub_node_id)
          : nodeIdToHex(decodeRevokeNodePayload(record.payload).node_id);
    } catch {
      return;
    }
    meshHubs.remove(hex);
    if (self && hex === self) opts.onRetireSelf?.();
  }
}
