import {
  KEYLOG_RECORD_COMPAT,
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  type KeyLogType,
  RELAY_RECORD_TYPES,
  RENAME_NODE_RECORD_TYPES,
  decodeKeyLogRecord,
} from '@vibeterm/shared/auth';
import type { UserStore } from '../auth/user-store';
import { nodeVersionMeets } from './node-version';

const SENTINEL_PEER_ID = 'hub';

export type UnsupportedKeyLogNode = { id: string; name: string; version: string | null };

export type KeyLogRecordCompatResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof KEYLOG_TYPE_UNSUPPORTED_BY_NODES;
      minVersion: string;
      nodes: UnsupportedKeyLogNode[];
      allowForce: boolean;
    };

export type KeyLogCompatOptions = {
  relayMode?: boolean;
  /** 本机节点编号：本机版本即当前版本，永不阻塞。 */
  localNodeId?: string | null;
  /** 为 true 时中继模式也不跳过未进入 peer_cache 的证书（readmit-node fail-closed）。 */
  failClosedUncached?: boolean;
};

/** 节点侧记录：中继两类 + rename-node。空 peer cache 时仅这些可 bootstrap 豁免。readmit-node 要求已有证书，不豁免。 */
function isNodeSideRecordType(type: string): boolean {
  return (
    (RELAY_RECORD_TYPES as readonly string[]).includes(type) ||
    (RENAME_NODE_RECORD_TYPES as readonly string[]).includes(type)
  );
}

function listActivePeers(userStore: UserStore) {
  return userStore.listPeers().filter((peer) => peer.nodeId !== SENTINEL_PEER_ID);
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

export function nodesBlockingMinVersion(
  userStore: UserStore,
  minVersion: string,
  userId?: string | null,
  opts?: KeyLogCompatOptions
): UnsupportedKeyLogNode[] {
  const relayMode = opts?.relayMode === true;
  const skipUncached =
    relayMode && !opts?.failClosedUncached && listActivePeers(userStore).length > 0;
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

export function inspectKeyLogRecordCompat(
  userStore: UserStore,
  recordBytes: Uint8Array,
  userId?: string | null,
  opts?: KeyLogCompatOptions
): KeyLogRecordCompatResult {
  let type: string;
  try {
    type = decodeKeyLogRecord(recordBytes).type;
  } catch {
    return { ok: true };
  }
  const spec = KEYLOG_RECORD_COMPAT[type as KeyLogType];
  if (!spec) return { ok: true };
  const relayMode = opts?.relayMode === true;
  // 版本来源：nodes.version，纯节点与中继模式退到 peer_cache.version；
  // 尚无任何已知成员时只豁免节点侧记录（首台 bootstrap），rotate-root-keep / readmit-node 仍 fail-closed。
  if (isNodeSideRecordType(type) && !hasKnownMembers(userStore, relayMode)) {
    return { ok: true };
  }
  // 版本未知的成员是否也要挡：由记录类型自己的兼容规格说了算（见 KeyLogRecordCompatSpec）。
  const failClosedUncached = spec.failClosedUncached === true;
  const nodes = nodesBlockingMinVersion(userStore, spec.minVersion, userId, {
    ...opts,
    failClosedUncached,
  });
  if (nodes.length === 0) return { ok: true };
  return {
    ok: false,
    code: KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
    minVersion: spec.minVersion,
    nodes,
    allowForce: spec.allowForce,
  };
}

/** force-keylog 内部头仅对 allowForce 的记录类型生效；`rotate-root-keep` 不可绕过。 */
export function applyForcedKeyLogCompat(
  compat: KeyLogRecordCompatResult,
  forced: boolean
): KeyLogRecordCompatResult {
  if (compat.ok) return compat;
  if (!forced || !compat.allowForce) return compat;
  console.warn(
    `[auth] forcing key-log append despite ${compat.code} minVersion=${compat.minVersion} nodes=${compat.nodes
      .map((n) => n.id)
      .join(',')}`
  );
  return { ok: true };
}
