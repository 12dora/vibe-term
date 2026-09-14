import { isPeerReachable } from './address-class';
import type { PeerReachKind } from './mesh-deps';

export type RemoteNodeLookupResult = 'online' | 'offline' | 'unknown';

export type InternalHttpForwarder = (
  nodeId: string,
  path: string,
  body: unknown,
  signal?: AbortSignal
) => Promise<Response>;

/** 带浏览器会话（`vibeterm_s_<nodeId>` cookie）转发到目标节点，用于代用户换取窗格授权。 */
export type AuthorizedHttpForwarder = (
  req: Request,
  input: { nodeId: string; method: string; path: string; body?: unknown }
) => Promise<Response>;

export interface MeshAgentBridge {
  selfNodeId: string;
  lookupNode(nodeId: string): RemoteNodeLookupResult;
  forwardInternalHttp: InternalHttpForwarder;
  forwardAuthorizedHttp: AuthorizedHttpForwarder;
}

let bridge: MeshAgentBridge | null = null;

export function setMeshAgentBridge(next: MeshAgentBridge | null): void {
  bridge = next;
}

export function getMeshAgentBridge(): MeshAgentBridge | null {
  return bridge;
}

/** 与 /api/mesh/nodes 投影一致：uplink 名册在线或直连可达即为在线。 */
export function isRemoteNodePresent(
  listedOnline: boolean,
  reach: PeerReachKind | undefined
): boolean {
  return listedOnline || isPeerReachable(reach);
}

export function lookupRemoteNode(
  nodeId: string,
  reachByPeer: ReadonlyMap<string, PeerReachKind | undefined>,
  listedOnlineIds: ReadonlySet<string>
): RemoteNodeLookupResult {
  if (!reachByPeer.has(nodeId)) {
    return 'unknown';
  }
  return isRemoteNodePresent(listedOnlineIds.has(nodeId), reachByPeer.get(nodeId))
    ? 'online'
    : 'offline';
}
