// Gateway 连接工厂：把 WS 客户端、pane-sink 注册表、选择状态机按连接组装。
// 多连接宿主每个 gateway 建一份；单连接宿主继续使用各模块的默认实例。

import { type BorshClientOptions, BorshWebSocketClient } from './client';
import { PaneSinkRegistry } from './pane-sink-registry';
import { type SelectCallbacks, SelectStateMachine } from './state-machine';

export interface GatewayConnectionOptions {
  /** WS 端点；缺省按 window.location 推导 */
  wsUrl?: string;
  clientOptions?: Partial<Omit<BorshClientOptions, 'url'>>;
  selectCallbacks?: SelectCallbacks;
}

export interface GatewayConnection {
  client: BorshWebSocketClient;
  paneSinks: PaneSinkRegistry;
  selectMachine: SelectStateMachine;
  dispose(): void;
}

export function createGatewayConnection(options: GatewayConnectionOptions = {}): GatewayConnection {
  const client = new BorshWebSocketClient({ ...options.clientOptions, url: options.wsUrl });
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
