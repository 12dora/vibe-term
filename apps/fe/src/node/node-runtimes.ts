// 宿主级的 node 运行时管理器与每 node 的 QueryClient。
//
// - 运行时（连接 / ApiClient / store）由 NodeConnectionManager 按 nodeId 懒建并引用计数。
// - React Query 缓存按 node 隔离：不是给每个 query key 加 nodeId 前缀（那要求改动所有
//   包内调用点，且会破坏包内既有的 `invalidateQueries(['files'])` 这类跨 key 失效），
//   而是每个 node 一个 QueryClient——隔离更彻底，且 key 语义完全不变。
// - 非 self 的 node 在建连时同时起一个 `DirectCarrierController`（F3-1）：信令走
//   `/mesh/ws` 的 `RTC_SIGNAL`，诊断挂到 `connection.directDiagnostics` 供设备页徽标读取，
//   并把 `BulkClient`（F3-2 的文件直传）按 nodeId 登记给文件面板。
//   `self` 是浏览器直接连的 entry，没有第二跳，永远不建直连。
// - 直连断开回落 primary 时，`setResumeSubscribedPanes` 钩子在这里接上该 node 的 pane
//   订阅面：重发订阅 + 对挂载中的 pane 重新拉一次画面，并提示用户最近输入可能未送达。

import { sonnerNotificationSink } from '@/lib/sonner-notification-sink';
import { QueryClient } from '@tanstack/react-query';
import { createNodeApiClient, isSelfNode, nodeWsUrl } from '@tmex/api-client';
import type { NotificationSink } from '@tmex/notifications';
import { type AppRuntime, NodeConnectionManager, normalizeNodeId } from '@tmex/stores';
import {
  BulkClient,
  DirectCarrierController,
  type DirectSignalMessage,
  type DirectSignalingTransport,
  type GatewayConnection,
  createGatewayConnection,
  registerBulkClient,
} from '@tmex/ws-client';
import { type MeshEventSource, sharedMeshEvents } from './mesh-events';

/**
 * `/mesh/ws` 的 `RTC_SIGNAL` 只有**一个** handler 槽（见 `mesh-events.ts` 的注释），
 * 而每个非 self 的 node 各有一个控制器，所以这里做一层扇出：信令按 `rtcSession` 由
 * 各控制器自行过滤，扇出不会让某个控制器抢答别人的 answer。
 *
 * `send` 如实返回 `sendRtcSignal` 的结果，并透出 `isReady` / `onReady`：`/mesh/ws` 正在
 * 退避重连时控制器不会白开 attempt，信令排队；连上后立刻重置直连退避重试一次。
 */
class MeshRtcSignalHub {
  private readonly handlers = new Set<(signal: DirectSignalMessage) => void>();
  private bound: MeshEventSource | null = null;

  constructor(private readonly resolveSource: () => MeshEventSource) {}

  transport(): DirectSignalingTransport {
    return {
      send: (signal) => this.source().sendRtcSignal(signal),
      onSignal: (cb) => {
        this.handlers.add(cb);
        this.bind();
        return () => {
          this.handlers.delete(cb);
        };
      },
      isReady: () => this.resolveSource().connected,
      onReady: (cb) => {
        const source = this.source();
        return source.onStatusChange(() => cb(source.connected));
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
  /** WS 关闭码回调（宿主用它识别 4401）。 */
  onClose?: (code: number) => void;
  /** 取该 node 的运行时（测试注入）；缺省从 `appNodeRuntimes` 取已建好的那份。 */
  resolveRuntime?: (nodeId: string) => AppRuntime | null;
  /** 直连断开提示的出口（测试注入）；缺省用 runtime 自己的 sink。 */
  notifications?: NotificationSink;
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
 * 取该 node 已建好的运行时。**不能触发懒建**：本函数会在 `createNodeConnection` 的
 * 回调里被调用，而 `createNodeConnection` 本身正是 manager 建 runtime 的一环，
 * 递归进去会栈溢出。runtime 还没建好时（直连不可能先于它断开）直接放弃这次补齐。
 */
function resolveExistingRuntime(nodeId: string): AppRuntime | null {
  return appNodeRuntimes.has(nodeId) ? appNodeRuntimes.get(nodeId).runtime : null;
}

/** 该 device 下当前**挂载着终端实例**的 pane（注册表里有 sink 即挂载中）。 */
function mountedPaneIds(
  connection: GatewayConnection,
  runtime: AppRuntime,
  deviceId: string
): string[] {
  const tmux = runtime.stores.tmux.getState();
  const ids = new Set<string>();
  for (const window of tmux.snapshots[deviceId]?.session?.windows ?? []) {
    for (const pane of window.panes) {
      if (connection.paneSinks.hasPaneSink(deviceId, pane.id)) ids.add(pane.id);
    }
  }
  const selected = tmux.selectedPanes[deviceId];
  if (selected && connection.paneSinks.hasPaneSink(deviceId, selected.paneId)) {
    ids.add(selected.paneId);
  }
  return [...ids];
}

/**
 * 切回 primary（含直连异常关闭）后的补齐：
 * 1. 重发该 device 的整份 pane 订阅——`mountPane()` 拿到的释放函数**立刻调用**，
 *    引用计数一加一减回到原值，但两次都会以新 generation 重下发当前订阅集合；
 *    订阅面在 `@tmex/stores`，没有对外暴露「只重发一次」的入口（见 result 备注）。
 * 2. 对挂载中的每个 pane 重新请求整屏快照，补上直连断开瞬间丢掉的输出。
 * 3. 提示用户：浏览器→node 方向的最近输入可能没送到（这一方向没有补齐机制）。
 */
function resumeSubscribedPanes(
  nodeId: string,
  connection: GatewayConnection,
  wiring: NodeDirectWiring
): void {
  const runtime = (wiring.resolveRuntime ?? resolveExistingRuntime)(nodeId);
  const sink = wiring.notifications ?? runtime?.notifications ?? sonnerNotificationSink;
  if (runtime) {
    const tmux = runtime.stores.tmux.getState();
    for (const deviceId of tmux.connectedDevices) {
      const paneIds = mountedPaneIds(connection, runtime, deviceId);
      const first = paneIds[0];
      if (first === undefined) continue;
      tmux.mountPane(deviceId, first)();
      for (const paneId of paneIds) tmux.requestPaneScreen(deviceId, paneId);
    }
  }
  const message =
    runtime?.t('device.directFallbackToast', {
      defaultValue: '直连已断开，最近输入可能未送达',
    }) ?? '直连已断开，最近输入可能未送达';
  sink.warning(message);
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
    wiring.createConnection ??
    ((id) =>
      createGatewayConnection({
        wsUrl: nodeWsUrl(id),
        ...(wiring.onClose ? { onClose: wiring.onClose } : {}),
      }))
  )(nodeId);
  if (isSelfNode(nodeId)) return connection;

  const controller = (wiring.createController ?? defaultController)(nodeId, connection);
  if (!controller) return connection;

  connection.directDiagnostics = controller.diagnosticsSource;
  connection.setResumeSubscribedPanes(() => resumeSubscribedPanes(nodeId, connection, wiring));
  // 文件面板只拿得到 nodeId，bulk 通道按 nodeId 登记（F3-2）。
  registerBulkClient(nodeId, new BulkClient(controller));
  const baseDispose = connection.dispose.bind(connection);
  connection.dispose = () => {
    connection.setResumeSubscribedPanes(null);
    registerBulkClient(nodeId, null);
    controller.stop();
    baseDispose();
  };
  controller.start();
  return connection;
}

export const appNodeRuntimes: NodeConnectionManager = new NodeConnectionManager({
  // 宿主只有一个 toaster，全部 node 共用同一个通知出口（不再经全局可变默认 sink）。
  notifications: sonnerNotificationSink,
  createConnection: (nodeId) =>
    createNodeConnection(nodeId, {
      // 自建连接绕过了 manager 的默认工厂，关闭码要自己转回去，4401 才有人处理。
      onClose: (code) => appNodeRuntimes.notifyClose(nodeId, code),
    }),
  // 引用计数归零、runtime 真正回收时一并释放该 node 的查询缓存。
  onDispose: (nodeId) => disposeNodeQueryClient(nodeId),
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
