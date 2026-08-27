// Gateway 连接工厂：把 WS 客户端、pane-sink 注册表、选择状态机按连接组装。
// 多连接宿主每个 gateway 建一份；单连接宿主继续使用各模块的默认实例。

import type { ActiveCarrier, DirectCarrierLike } from './carrier-switch';
import {
  type BorshClientOptions,
  BorshWebSocketClient,
  type SocketFactory,
  type WebSocketLike,
} from './client';
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
  /**
   * 每次底层 socket 关闭时的关闭码回调（`CloseEvent.code`，取不到则 1006）。
   * 宿主用它识别 **4401**（会话失效）：停掉重连并按 self / 目标 node 派发一次鉴权事件，
   * 否则客户端会一直重连并被立刻关掉。
   */
  onClose?: (code: number) => void;
}

/**
 * 把关闭码透出给宿主：在 socket 与 client 之间插一层薄壳，
 * 自己占住真 socket 的 `onclose`，先调 `onClose(code)` 再转给 client 的处理函数。
 * client 侧代码完全不变（它拿到的仍是一个 `WebSocketLike`）。
 */
function withCloseCode(factory: SocketFactory, onClose: (code: number) => void): SocketFactory {
  return (url) => {
    const socket = factory(url);
    let downstream: ((event?: unknown) => void) | null = null;
    socket.onclose = (event) => {
      const raw = (event as { code?: unknown } | undefined)?.code;
      try {
        onClose(typeof raw === 'number' ? raw : 1006);
      } catch {
        // 宿主回调异常不得影响连接收敛
      }
      downstream?.(event);
    };
    const shim: WebSocketLike = {
      get readyState() {
        return socket.readyState;
      },
      get binaryType() {
        return socket.binaryType;
      },
      set binaryType(value) {
        socket.binaryType = value;
      },
      get onopen() {
        return socket.onopen;
      },
      set onopen(handler) {
        socket.onopen = handler;
      },
      get onmessage() {
        return socket.onmessage;
      },
      set onmessage(handler) {
        socket.onmessage = handler;
      },
      get onerror() {
        return socket.onerror;
      },
      set onerror(handler) {
        socket.onerror = handler;
      },
      get onclose() {
        return downstream;
      },
      set onclose(handler) {
        downstream = handler;
      },
      send(data) {
        socket.send(data);
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    };
    return shim;
  };
}

const browserSocketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as WebSocketLike;

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
   * 注入「切回 primary 时补齐已订阅 pane」的钩子（宿主按 node 接自己的订阅管理器）。
   * 直连断开瞬间 node→浏览器方向可能有已写出但未送达的帧，靠这条路径重发订阅 + 重取画面。
   */
  setResumeSubscribedPanes(fn: (() => void) | null): void;
  /**
   * 直连诊断源。由宿主在建连时挂上 `DirectCarrierController.diagnosticsSource`；
   * 为空时 `resolveDirectDiagnostics()` 回落到恒为 primary 的桩。
   */
  directDiagnostics: DirectDiagnosticsSource | null;
  dispose(): void;
}

export function createGatewayConnection(options: GatewayConnectionOptions = {}): GatewayConnection {
  const socketFactory = options.onClose
    ? withCloseCode(options.socketFactory ?? browserSocketFactory, options.onClose)
    : options.socketFactory;
  const client = new BorshWebSocketClient({
    ...options.clientOptions,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    url: options.wsUrl,
    socketFactory,
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
    setResumeSubscribedPanes(fn) {
      client.setResumeSubscribedPanes(fn);
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
