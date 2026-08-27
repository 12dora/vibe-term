// Gateway 连接工厂：把 WS 客户端、pane-sink 注册表、选择状态机按连接组装。
// 多连接宿主每个 gateway 建一份；单连接宿主继续使用各模块的默认实例。

import type { ActiveCarrier, DirectCarrierLike } from './carrier-switch';
import { type BorshClientOptions, BorshWebSocketClient, type SocketFactory } from './client';
import type { DirectDiagnosticsSource } from './direct/types';
import { PaneSinkRegistry } from './pane-sink-registry';
import { type SelectCallbacks, SelectStateMachine } from './state-machine';
import { type GatewayTransport, WebSocketGatewayTransport } from './transport';

export interface GatewayConnectionOptions {
  /** WS 端点；缺省按 window.location 推导 */
  wsUrl?: string;
  /** 自定义 transport 工厂；缺省为 `new WebSocket(wsUrl)` */
  socketFactory?: SocketFactory;
  /** 本连接可接收的单个 WS frame 上限；顶层值优先于 clientOptions。 */
  maxFrameBytes?: number;
  clientOptions?: Partial<Omit<BorshClientOptions, 'url' | 'socketFactory'>>;
  selectCallbacks?: SelectCallbacks;
  /**
   * 宿主持有的共享数据通道。传入后 tmux store 只消费该 typed transport；构造连接不会
   * 为 metadata/runtime 创建额外 WebSocket。
   */
  transport?: GatewayTransport;
}

export interface GatewayConnection {
  client: BorshWebSocketClient;
  transport: GatewayTransport;
  paneSinks: PaneSinkRegistry;
  selectMachine: SelectStateMachine;
  /** 挂载直连载体（`DirectCarrierController` 在 `sess` 首帧鉴权通过后调用）。 */
  attachDirectCarrier(carrier: DirectCarrierLike): void;
  /** 摘掉直连，回落 primary。 */
  detachDirectCarrier(): void;
  /** 当前活跃载体。 */
  readonly activeCarrier: ActiveCarrier;
  onCarrierChange(handler: (active: ActiveCarrier) => void): () => void;
  /**
   * 直连诊断源。由宿主在建连时挂上 `DirectCarrierController.diagnosticsSource`；
   * 为空时 `resolveDirectDiagnostics()` 回落到恒为 primary 的桩。
   */
  directDiagnostics: DirectDiagnosticsSource | null;
  dispose(): void;
}

export function createGatewayConnection(options: GatewayConnectionOptions = {}): GatewayConnection {
  const client = new BorshWebSocketClient({
    ...options.clientOptions,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    url: options.wsUrl,
    socketFactory: options.socketFactory,
  });
  const paneSinks = new PaneSinkRegistry();
  const selectMachine = new SelectStateMachine(options.selectCallbacks);
  const transport = options.transport ?? new WebSocketGatewayTransport(client);
  const ownsTransport = options.transport === undefined;

  return {
    client,
    transport,
    paneSinks,
    selectMachine,
    directDiagnostics: null,
    attachDirectCarrier(carrier) {
      client.attachDirectCarrier(carrier);
    },
    detachDirectCarrier() {
      client.detachDirectCarrier();
    },
    get activeCarrier() {
      return client.activeCarrier;
    },
    onCarrierChange(handler) {
      return client.onCarrierChange(handler);
    },
    dispose() {
      selectMachine.cleanupAll();
      paneSinks.reset();
      if (ownsTransport) {
        transport.disconnect();
        transport.dispose();
      } else {
        client.disconnect();
      }
    },
  };
}
