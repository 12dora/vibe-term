// Gateway transport 门面：保持既有 import 路径，实现拆分在同目录的四个模块中。

export type {
  EncodedGatewayCommand,
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalCursor,
  GatewayTerminalData,
  GatewayTransport,
  GatewayTransportCapabilities,
  GatewayTransportCommand,
  GatewayTransportEvent,
  GatewayTransportEventHandler,
  GatewayTransportSourceRoute,
} from './transport-types';

export { encodeGatewayTransportCommand } from './transport-command-encoder';
export { decodeGatewayTransportMessage } from './transport-message-decoder';
export { LazyWebSocketGatewayTransport, WebSocketGatewayTransport } from './websocket-transport';
export {
  createSharedGatewayTransport,
  type SharedGatewayTransport,
  type SharedGatewayTransportOptions,
} from './shared-transport';
