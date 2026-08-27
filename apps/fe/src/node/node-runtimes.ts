// 宿主级的 node 运行时管理器与每 node 的 QueryClient。
//
// - 运行时（连接 / ApiClient / store）由 NodeConnectionManager 按 nodeId 懒建并引用计数。
// - React Query 缓存按 node 隔离：不是给每个 query key 加 nodeId 前缀（那要求改动所有
//   包内调用点，且会破坏包内既有的 `invalidateQueries(['files'])` 这类跨 key 失效），
//   而是每个 node 一个 QueryClient——隔离更彻底，且 key 语义完全不变。
// - 非 self 的 node 在建连时同时起一个 `DirectCarrierController`（F3-1）：信令走
//   `/mesh/ws` 的 `RTC_SIGNAL`，诊断挂到 `connection.directDiagnostics` 供设备页徽标读取。
//   `self` 是浏览器直接连的 entry，没有第二跳，永远不建直连。

import { sonnerNotificationSink } from '@/lib/sonner-notification-sink';
import { QueryClient } from '@tanstack/react-query';
import { createNodeApiClient, isSelfNode, nodeWsUrl } from '@tmex/api-client';
import { NodeConnectionManager, normalizeNodeId } from '@tmex/stores';
import {
  DirectCarrierController,
  type DirectSignalMessage,
  type DirectSignalingTransport,
  type GatewayConnection,
  createGatewayConnection,
} from '@tmex/ws-client';
import { type MeshEventSource, sharedMeshEvents } from './mesh-events';

/**
 * `/mesh/ws` 的 `RTC_SIGNAL` 只有**一个** handler 槽（见 `mesh-events.ts` 的注释），
 * 而每个非 self 的 node 各有一个控制器，所以这里做一层扇出：信令按 `rtcSession` 由
 * 各控制器自行过滤，扇出不会让某个控制器抢答别人的 answer。
 */
class MeshRtcSignalHub {
  private readonly handlers = new Set<(signal: DirectSignalMessage) => void>();
  private bound: MeshEventSource | null = null;

  constructor(private readonly resolveSource: () => MeshEventSource) {}

  transport(): DirectSignalingTransport {
    return {
      send: (signal) => {
        this.source().sendRtcSignal(signal);
      },
      onSignal: (cb) => {
        this.handlers.add(cb);
        this.bind();
        return () => {
          this.handlers.delete(cb);
        };
      },
    };
  }

  private source(): MeshEventSource {
    const source = this.resolveSource();
    source.start();
    return source;
  }

  private bind(): void {
    const source = this.source();
    if (this.bound === source) return;
    this.bound = source;
    source.setRtcSignalHandler((signal) => {
      for (const handler of [...this.handlers]) handler(signal);
    });
  }
}

const meshRtcSignals = new MeshRtcSignalHub(() => sharedMeshEvents());

export interface NodeDirectWiring {
  createConnection?: (nodeId: string) => GatewayConnection;
  createController?: (
    nodeId: string,
    connection: GatewayConnection
  ) => DirectCarrierController | null;
}

function defaultController(nodeId: string, connection: GatewayConnection): DirectCarrierController {
  return new DirectCarrierController({
    nodeId,
    apiClient: createNodeApiClient(nodeId),
    signaling: meshRtcSignals.transport(),
    connection,
  });
}

/**
 * 建一个 node 的 `GatewayConnection`，非 self 的顺带起直连控制器。
 * 控制器随连接 `dispose()` 一并停掉（否则 30 s 宽限期回收后 RTCPeerConnection 会漏）。
 */
export function createNodeConnection(
  nodeId: string,
  wiring: NodeDirectWiring = {}
): GatewayConnection {
  const connection = (
    wiring.createConnection ?? ((id) => createGatewayConnection({ wsUrl: nodeWsUrl(id) }))
  )(nodeId);
  if (isSelfNode(nodeId)) return connection;

  const controller = (wiring.createController ?? defaultController)(nodeId, connection);
  if (!controller) return connection;

  connection.directDiagnostics = controller.diagnosticsSource;
  const baseDispose = connection.dispose.bind(connection);
  connection.dispose = () => {
    controller.stop();
    baseDispose();
  };
  controller.start();
  return connection;
}

export const appNodeRuntimes = new NodeConnectionManager({
  // 宿主只有一个 toaster，全部 node 共用同一个通知出口（不再经全局可变默认 sink）。
  notifications: sonnerNotificationSink,
  createConnection: (nodeId) => createNodeConnection(nodeId),
});

function createNodeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5000,
        retry: 1,
      },
    },
  });
}

const queryClients = new Map<string, QueryClient>();

/** 取该 node 的 QueryClient（懒建）。 */
export function nodeQueryClient(nodeId: string | undefined): QueryClient {
  const id = normalizeNodeId(nodeId);
  let client = queryClients.get(id);
  if (!client) {
    client = createNodeQueryClient();
    queryClients.set(id, client);
  }
  return client;
}

/** 释放该 node 的查询缓存（运行时被回收时调用）。 */
export function disposeNodeQueryClient(nodeId: string | undefined): void {
  const id = normalizeNodeId(nodeId);
  const client = queryClients.get(id);
  if (!client) return;
  queryClients.delete(id);
  client.clear();
}
