import { compareSemver } from '@tmex/shared';
import {
  HUB_AUTH_RECORD_TYPES,
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_HUB_AUTH_RECORD_VERSION,
  decodeAdmitHubPayload,
  decodeKeyLogRecord,
  decodeRetireHubPayload,
  decodeRevokeNodePayload,
  nodeIdToHex,
} from '@tmex/shared/auth';
import type { MeshHubStore } from '../auth/mesh-hub-store';
import type { UserStore } from '../auth/user-store';

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
    };

export function isHubAuthRecordType(type: string): boolean {
  return (HUB_AUTH_RECORD_TYPES as readonly string[]).includes(type);
}

export function normalizeReportedNodeVersion(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/_dev$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

export function nodeVersionSupportsHubAuthRecords(raw: string | null | undefined): boolean {
  const version = normalizeReportedNodeVersion(raw);
  if (!version) return false;
  const cmp = compareSemver(version, MIN_HUB_AUTH_RECORD_VERSION);
  return cmp !== null && cmp >= 0;
}

export function nodesBlockingHubAuthRecords(
  userStore: UserStore,
  userId?: string | null
): UnsupportedKeyLogNode[] {
  const blocked: UnsupportedKeyLogNode[] = [];
  for (const node of userStore.listNodes()) {
    if (node.status === 'revoked') continue;
    if (userId && node.userId !== userId) continue;
    if (nodeVersionSupportsHubAuthRecords(node.version)) continue;
    blocked.push({ id: node.id, name: node.name, version: node.version });
  }
  return blocked;
}

export function inspectHubAuthRecordCompat(
  userStore: UserStore,
  recordBytes: Uint8Array,
  userId?: string | null
): HubAuthRecordCompatResult {
  let type: string;
  try {
    type = decodeKeyLogRecord(recordBytes).type;
  } catch {
    return { ok: true };
  }
  if (!isHubAuthRecordType(type)) return { ok: true };
  const nodes = nodesBlockingHubAuthRecords(userStore, userId);
  if (nodes.length === 0) return { ok: true };
  return {
    ok: false,
    code: KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
    minVersion: MIN_HUB_AUTH_RECORD_VERSION,
    nodes,
  };
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
