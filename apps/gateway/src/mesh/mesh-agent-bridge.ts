import { isPeerReachable } from './address-class';
import type { PeerReachKind } from './mesh-deps';

export type RemoteNodeLookupResult = 'online' | 'offline' | 'unknown';

export type InternalHttpForwarder = (
  nodeId: string,
  path: string,
  body: unknown,
  signal?: AbortSignal
) => Promise<Response>;

export interface MeshAgentBridge {
  lookupNode(nodeId: string): RemoteNodeLookupResult;
  forwardInternalHttp: InternalHttpForwarder;
}

let bridge: MeshAgentBridge | null = null;

export function setMeshAgentBridge(next: MeshAgentBridge | null): void {
  bridge = next;
}

export function getMeshAgentBridge(): MeshAgentBridge | null {
  return bridge;
}

/** 与 /api/mesh/nodes 投影一致：hub presence 或直连可达即为在线。 */
export function isRemoteNodePresent(hubOnline: boolean, reach: PeerReachKind | undefined): boolean {
  return hubOnline || isPeerReachable(reach);
}

export function lookupRemoteNode(
  nodeId: string,
  reachByPeer: ReadonlyMap<string, PeerReachKind | undefined>,
  hubOnlineIds: ReadonlySet<string>
): RemoteNodeLookupResult {
  if (!reachByPeer.has(nodeId)) {
    return 'unknown';
  }
  return isRemoteNodePresent(hubOnlineIds.has(nodeId), reachByPeer.get(nodeId))
    ? 'online'
    : 'offline';
}
