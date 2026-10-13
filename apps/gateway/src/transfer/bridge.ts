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

/**
 * 单机（未配置 mesh/中继）时本机在传输模块里的内部身份。刻意取 32 位十六进制之外的值：
 * 真实 node id 是随机 16 字节、注册时接受任意 16 字节 id，没有任何十六进制值能保证不被占用，
 * 所以该身份无法由客户端以 node id 的形式写出，只能经 `self` 别名落到这里。
 * 只用于同节点任务的授权与会话归属比对，不上 mesh 链路，对浏览器一律以 `self` 暴露。
 */
export const STANDALONE_TRANSFER_NODE_ID = 'standalone';

/** 传输模块里的「本机 node id」：有 mesh 用 mesh 身份，否则用单机占位身份。 */
export function transferSelfNodeId(): string {
  return bridge?.selfNodeId ?? STANDALONE_TRANSFER_NODE_ID;
}

/** 任务快照里给浏览器看的 node id：单机占位身份折回 `self`，其余原样。 */
export function publicTransferNodeId(nodeId: string): string {
  return nodeId === STANDALONE_TRANSFER_NODE_ID ? 'self' : nodeId;
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
