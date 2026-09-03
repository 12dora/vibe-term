// 直连（WebRTC DataChannel）栈的出口。
//
// 刻意**不**从 `@tmex/ws-client` 的主 barrel 再导出：直连只在浏览器为「远端 node」建连时
// 才用得上，主 barrel 一旦 re-export 就把整棵 RTC 栈钉死在首屏入口 chunk 里。宿主按需
// `await import('@tmex/ws-client/direct')`，诊断/类型这类轻量契约仍走 `./direct/types`。

export {
  DirectCarrierController,
  buildIceServers,
  meshConnectionPath,
  MESH_CONNECTION_PATH,
  SESS_CHANNEL_LABEL,
  type DirectCarrierControllerOptions,
  type DirectCarrierState,
  type GatewayConnectionLike,
} from './direct-carrier-controller';

export {
  DIRECT_DIAL_BREAKER_BASE_MS,
  DIRECT_DIAL_BREAKER_FAILS,
  DIRECT_DIAL_BREAKER_HEALTHY_MS,
  DIRECT_DIAL_BREAKER_MAX_MS,
  DirectDialBreaker,
  classifyDirectDialFailure,
  type DirectDialBreakerDecision,
  type DirectDialBreakerSnapshot,
} from './direct-dial-breaker';

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
} from './bulk-client';

export {
  DirectDataChannelCarrier,
  DC_HIGH_WATER_BYTES,
  DC_LOW_WATER_BYTES,
  type CarrierSendResult,
  type RTCDataChannelLike,
} from './data-channel-carrier';

export {
  FrameReassembler,
  fragmentFrame,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
} from './fragmenter';

export {
  deriveRoute,
  describePair,
  readSelectedPair,
  type DirectRoute,
  type SelectedPairStats,
} from './ice-stats';

export {
  fingerprintsEqual,
  normalizeFingerprint,
  parseSdpFingerprint,
  type DtlsFingerprint,
} from './fingerprint';

export type {
  DirectApiClientLike,
  DirectSignalMessage,
  DirectSignalingTransport,
  RTCPeerConnectionLike,
  RtcPeerConnectionFactory,
} from './rtc-types';

export {
  PRIMARY_ONLY_DIAGNOSTICS,
  createDeferredDiagnosticsSource,
  createStubDirectDiagnosticsSource,
  resolveDirectDiagnostics,
  type DeferredDirectDiagnosticsSource,
  type DirectCarrierPath,
  type DirectDiagnostics,
  type DirectDiagnosticsSource,
  type DirectIceDiagnostics,
} from './types';
