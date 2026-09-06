// 传输模块访问 mesh 的唯一入口。与 `mesh-agent-bridge` 同样的形式：mesh 启动时注入，
// 非 mesh 代码不直接依赖 PeerManager / Forwarder。

export type TransferPeerTransport = 'dc' | 'ws-secure' | 'relay';

export interface TransferMeshBridge {
  selfNodeId: string;
  /** 当前活链路的载体；没有活链路返回 null（拨号后才知道）。 */
  transportOf(nodeId: string): TransferPeerTransport | null;
  forwardInternalHttp(
    nodeId: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    input?: {
      method?: string;
      query?: string;
      headers?: Record<string, string>;
      rawBody?: ReadableStream<Uint8Array>;
      onProgress?: (uploadedBytes: number) => void;
    }
  ): Promise<Response>;
}

let bridge: TransferMeshBridge | null = null;

export function setTransferMeshBridge(next: TransferMeshBridge | null): void {
  bridge = next;
}

export function getTransferMeshBridge(): TransferMeshBridge | null {
  return bridge;
}

/** 中继链路按流计配额，压到 2 条；直连（含同机）默认 4 条。 */
export function streamsForTransport(transport: TransferPeerTransport | null): number {
  return transport === 'relay' ? 2 : 4;
}

/** mesh 启动时接线，独立成函数让 `wireMeshHttp` 保持在长度门禁内。 */
export function wireTransferBridge(
  selfNodeId: string,
  transportOf: (nodeId: string) => TransferPeerTransport | null,
  forwarder: Pick<TransferMeshBridge, 'forwardInternalHttp'>
): void {
  setTransferMeshBridge({
    selfNodeId,
    transportOf,
    forwardInternalHttp: (nodeId, path, body, signal, extra) =>
      forwarder.forwardInternalHttp(nodeId, path, body, signal, extra),
  });
}
