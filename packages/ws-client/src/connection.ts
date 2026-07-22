// Gateway 连接工厂：把 WS 客户端、pane-sink 注册表、选择状态机按连接组装。
// 多连接宿主每个 gateway 建一份；单连接宿主继续使用各模块的默认实例。

import { type BorshClientOptions, BorshWebSocketClient, type SocketFactory } from './client';
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
