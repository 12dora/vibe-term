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

export {
  DirectCarrierController,
  buildIceServers,
  meshConnectionPath,
  MESH_CONNECTION_PATH,
  SESS_CHANNEL_LABEL,
  type DirectCarrierControllerOptions,
  type DirectCarrierState,
  type GatewayConnectionLike,
} from './direct/direct-carrier-controller';

export {
  BulkClient,
  BulkTransferError,
  bulkChannelLabel,
  clearBulkClients,
  getBulkClient,
  iterateBulkFrames,
  registerBulkClient,
  BULK_CHANNEL_PREFIX,
  BULK_FRAME_SIZE,
  DEFAULT_BULK_OPEN_TIMEOUT_MS,
  type BulkChannelSource,
  type BulkClientOptions,
  type BulkDownloadRequest,
  type BulkResult,
  type BulkUploadRequest,
} from './direct/bulk-client';

export {
  DirectDataChannelCarrier,
  DC_HIGH_WATER_BYTES,
  DC_LOW_WATER_BYTES,
  type CarrierSendResult,
  type RTCDataChannelLike,
} from './direct/data-channel-carrier';

export {
  FrameReassembler,
  fragmentFrame,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
} from './direct/fragmenter';

export {
  deriveRoute,
  describePair,
  readSelectedPair,
  type DirectRoute,
  type SelectedPairStats,
} from './direct/ice-stats';

export {
  fingerprintsEqual,
  normalizeFingerprint,
  parseSdpFingerprint,
  type DtlsFingerprint,
} from './direct/fingerprint';

export type {
  DirectApiClientLike,
  DirectSignalMessage,
  DirectSignalingTransport,
  RTCPeerConnectionLike,
  RtcPeerConnectionFactory,
} from './direct/rtc-types';

export {
  PRIMARY_ONLY_DIAGNOSTICS,
  createStubDirectDiagnosticsSource,
  resolveDirectDiagnostics,
  type DirectCarrierPath,
  type DirectDiagnostics,
  type DirectDiagnosticsSource,
  type DirectIceDiagnostics,
} from './direct/types';

export {
  WebSocketGatewayTransport,
  LazyWebSocketGatewayTransport,
  createSharedGatewayTransport,
  encodeGatewayTransportCommand,
  type GatewayHistoryCursor,
  type GatewayPaneHistoryPage,
  type GatewayPaneScreenSnapshot,
  type GatewayRebaseReason,
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

export {
  PaneSinkRegistry,
  type PaneSink,
  type PaneResetOrigin,
} from './pane-sink-registry';

export {
  SelectStateMachine,
  getSelectStateMachine,
  type SelectTransactionState,
  type SelectTransaction,
  type OutputGateState,
  type OutputGate,
  type SelectStartEvent,
  type SwitchAckEvent,
  type HistoryEvent,
  type LiveResumeEvent,
  type OutputEvent,
  type SelectFailedEvent,
  type SelectEvent,
  type SelectCallbacks,
  type SelectFailureReason,
  type SelectTimerScheduler,
  type SelectStateMachineOptions,
} from './state-machine';

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
  buildTmuxSubscribePanes,
  buildTmuxFetchPaneHistory,
  buildTmuxResizePane,
  buildTmuxApplyStackedLayout,
  buildTmuxSplitPane,
  buildTmuxFocusPane,
  buildTmuxRenamePane,
  buildTmuxMovePane,
  buildTmuxBreakPane,
  type MovePanePosition,
  buildTermInput,
  buildTermPaste,
  buildTermResize,
  buildTermSyncSize,
  buildTermViewportMessage,
  buildAgentSubscribe,
  buildAgentUnsubscribe,
  buildSiteThemeUpdate,
  type TmuxSelectParams,
} from './message-builder';
