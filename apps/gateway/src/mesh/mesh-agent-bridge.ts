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
