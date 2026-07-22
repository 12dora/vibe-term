// Gateway 连接工厂：把 WS 客户端、pane-sink 注册表、选择状态机按连接组装。
// 多连接宿主每个 gateway 建一份；单连接宿主继续使用各模块的默认实例。

import { type BorshClientOptions, BorshWebSocketClient, type SocketFactory } from './client';
import { PaneSinkRegistry } from './pane-sink-registry';
import { type SelectCallbacks, SelectStateMachine } from './state-machine';

export interface GatewayConnectionOptions {
  /** WS 端点；缺省按 window.location 推导 */
  wsUrl?: string;
  /** 自定义 transport 工厂；缺省为 `new WebSocket(wsUrl)` */
  socketFactory?: SocketFactory;
  /** 本连接可接收的单个 WS frame 上限；顶层值优先于 clientOptions。 */
  maxFrameBytes?: number;
  clientOptions?: Partial<Omit<BorshClientOptions, 'url' | 'socketFactory'>>;
  selectCallbacks?: SelectCallbacks;
}

export interface GatewayConnection {
  client: BorshWebSocketClient;
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

  return {
    client,
    paneSinks,
    selectMachine,
    dispose() {
      selectMachine.cleanupAll();
      paneSinks.reset();
      client.disconnect();
    },
  };
}
