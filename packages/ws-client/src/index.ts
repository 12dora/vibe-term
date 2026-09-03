// WebSocket Borsh 协议客户端模块

export {
  BorshWebSocketClient,
  defaultWsUrl,
  getBorshClient,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
  DEFAULT_HIDDEN_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HIDDEN_HEARTBEAT_TIMEOUT_MS,
  type BorshClientOptions,
  type ClientSendResult,
  type ConnectionState,
  type StateFeedMode,
  type BorshMessage,
  type MessageHandler,
  type StateChangeHandler,
  type ErrorHandler,
  type ChunkProgress,
  type ChunkProgressHandler,
  type PendingOverflowHandler,
  type PendingOverflowInfo,
  type WebSocketLike,
  type SocketFactory,
  getDefaultClientVersion,
  setDefaultClientVersion,
} from './client';

export {
  TERM_VIEWPORT_MIN_SERVER_VERSION,
  serverSupportsTermViewport,
} from './server-features';

export {
  createGatewayConnection,
  type GatewayConnection,
  type GatewayConnectionOptions,
} from './connection';

export {
  CarrierSwitchBarrier,
  peekEnvelopeKind,
  type ActiveCarrier,
  type AttachDirectOptions,
  type CarrierSwitchBarrierOptions,
  type DirectCarrierLike,
} from './carrier-switch';

// 直连（WebRTC）栈**不**从这里导出：整棵 RTC 栈约 19 KB gz，一旦进主 barrel 就钉死在
// 首屏入口 chunk。宿主按需 `import('@tmex/ws-client/direct')`，轻量诊断契约走
// `@tmex/ws-client/direct/types`。

export {
  WebSocketGatewayTransport,
  LazyWebSocketGatewayTransport,
  createSharedGatewayTransport,
  encodeCanonicalGatewayCommand,
  encodeGatewayTransportCommand,
  type GatewayHistoryCursor,
  type GatewayPaneHistoryPage,
  type GatewayPaneScreenSnapshot,
  type GatewayRebaseReason,
  type GatewaySubscriptionRejection,
  type GatewaySubscriptionRejectionReason,
  type GatewayTerminalCursor,
  type GatewayTerminalData,
  type GatewayTransport,
  type GatewayTransportCapabilities,
  type GatewayTransportCommand,
  type GatewayNodeEvent,
  type GatewayTransportEvent,
  type GatewayTransportSourceRoute,
  type TerminalViewportPolicyEvent,
  type SharedGatewayTransport,
  type SharedGatewayTransportOptions,
} from './transport';

export { PaneSinkRegistry, type PaneSink } from './pane-sink-registry';

export {
  generateSelectToken,
  buildDeviceConnect,
  buildDeviceDisconnect,
  buildTmuxSelect,
  buildTmuxSelectWindow,
  buildTmuxCreateWindow,
  buildTmuxCloseWindow,
  buildTmuxClosePane,
  buildTmuxRenameWindow,
  buildTmuxSetWindowStyle,
  buildTmuxReorderWindows,
  buildTmuxReorderPanes,
  buildTmuxResizePane,
  buildTmuxApplyStackedLayout,
  buildTmuxSplitPane,
  buildTmuxFocusPane,
  buildTmuxRenamePane,
  buildTmuxMovePane,
  buildTmuxBreakPane,
  type MovePanePosition,
  buildTermViewportMessage,
  buildAgentSubscribe,
  buildAgentUnsubscribe,
  buildSiteThemeUpdate,
  type TmuxSelectParams,
} from './message-builder';
