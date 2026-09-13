import type { UserStore } from '../auth/user-store';
import { MESH_VIA_SELF } from './mesh-deps';
import type { NodeEventWireInput } from './node-event-wire';
import type { MeshNodeDto } from './node-list-projection';
import { readNodeOperation } from './node-operations';
import { dropPausedPeerLink, setNodePaused } from './node-pause';
import {
  type SessionMiddlewareDeps,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';

export type MeshPauseRouteHost = {
  sessionDeps: SessionMiddlewareDeps;
  selfNodeId: string;
  userStore: UserStore;
  collectNodes: (req: Request) => MeshNodeDto[];
  broadcastNodeEvent: (event: NodeEventWireInput) => void;
};

export function matchMeshPauseRoute(
  req: Request,
  path: string,
  host: MeshPauseRouteHost
): Promise<Response> | undefined {
  const match = path.match(/^\/api\/mesh\/nodes\/([^/]+)\/(pause|resume)$/);
  if (!match || req.method !== 'POST') return undefined;
  const nodeId = decodeURIComponent(match[1] ?? '');
  const paused = match[2] === 'pause';
  return requireSession(host.sessionDeps, (r) => handlePauseResume(r, nodeId, paused, host))(req);
}

function isSelfNode(selfId: string, nodeId: string): boolean {
  return nodeId === selfId || nodeId === MESH_VIA_SELF;
}

function isEnrolledMember(userStore: UserStore, nodeId: string): boolean {
  const cert = userStore.getCert(nodeId);
  return cert != null && cert.revokedLogSeq == null;
}

function inventoryWire(inventory: unknown): string | null {
  if (inventory == null) return null;
  return typeof inventory === 'string' ? inventory : JSON.stringify(inventory);
}

function eventFromNode(node: MeshNodeDto, paused: boolean): NodeEventWireInput {
  return {
    nodeId: node.id,
    status: node.online ? 'online' : 'offline',
    reach: node.reach,
    transport: node.transport,
    rttMs: node.rttMs,
    inventory: inventoryWire(node.inventory),
    version: node.version,
    direct_capable: node.direct_capable,
    name: node.name,
    viaRelay: node.viaRelay,
    relayPresence: node.relayPresence,
    paused,
  };
}

function handlePauseResume(
  req: Request,
  nodeId: string,
  paused: boolean,
  host: MeshPauseRouteHost
): Response {
  if (isSelfNode(host.selfNodeId, nodeId)) {
    return jsonError('CANNOT_PAUSE_SELF', 400);
  }
  if (!isEnrolledMember(host.userStore, nodeId)) {
    return jsonError('NODE_NOT_FOUND', 404);
  }
  // 先确认节点仍在列表里再落库，避免校验与收集之间节点被移除时留下孤立偏好
  const listed = host.collectNodes(req).find((row) => row.id === nodeId);
  if (!listed) return jsonError('NODE_NOT_FOUND', 404);
  if (listed.isHub && paused) return jsonError('CANNOT_PAUSE_HUB', 400);
  setNodePaused(nodeId, paused);
  if (paused) dropPausedPeerLink(nodeId);
  const node = { ...listed, paused: paused || undefined };
  host.broadcastNodeEvent(eventFromNode(node, paused));
  return jsonBody({ ok: true, node: { ...node, operation: readNodeOperation(node.id) } });
}
