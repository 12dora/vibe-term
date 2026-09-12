import type { UserStore } from '../auth/user-store';
import { MESH_VIA_SELF } from './mesh-deps';
import { type MeshNodeDto, overlayPausedMeshNodes } from './node-list-projection';
import { meshPortsForNode, overlayMeshNodePorts, probePeerEndpoints } from './port-reach';
import {
  type SessionMiddlewareDeps,
  jsonBody,
  jsonError,
  requireSession,
} from './session-middleware';

export function overlayMeshList(
  nodes: MeshNodeDto[],
  selfId: string,
  pausedIds: ReadonlySet<string>
): MeshNodeDto[] {
  return overlayMeshNodePorts(overlayPausedMeshNodes(nodes, selfId, pausedIds), selfId);
}

export type MeshPortsRouteHost = {
  sessionDeps: SessionMiddlewareDeps;
  selfNodeId: string;
  userStore: UserStore;
  collectNodes: (req: Request) => MeshNodeDto[];
};

export function matchMeshPortsRoute(
  req: Request,
  path: string,
  host: MeshPortsRouteHost
): Promise<Response> | undefined {
  const match = path.match(/^\/api\/mesh\/nodes\/([^/]+)\/ports\/probe$/);
  if (!match || req.method !== 'POST') return undefined;
  const nodeId = decodeURIComponent(match[1] ?? '');
  return requireSession(host.sessionDeps, (r) => handlePortsProbe(r, nodeId, host))(req);
}

function isSelfNode(selfId: string, nodeId: string): boolean {
  return nodeId === selfId || nodeId === MESH_VIA_SELF;
}

async function handlePortsProbe(
  req: Request,
  nodeId: string,
  host: MeshPortsRouteHost
): Promise<Response> {
  const self = isSelfNode(host.selfNodeId, nodeId);
  const targetId = self ? host.selfNodeId : nodeId;
  const node = host.collectNodes(req).find((row) => row.id === targetId);
  if (!node) return jsonError('NODE_NOT_FOUND', 404);
  if (!self) {
    await probePeerEndpoints(targetId, node.endpoints ?? [], { force: true });
  }
  return jsonBody({
    ports: meshPortsForNode({
      nodeId: targetId,
      selfId: host.selfNodeId,
      endpoints: node.endpoints,
      directFailure: node.directFailure,
    }),
  });
}
