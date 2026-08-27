// `RTCPeerConnection` / 信令 / REST 的最小结构子集。
//
// 不直接用 lib.dom 的 `RTCPeerConnection`：测试里的假实现只需要满足这里列出的成员，
// 不必伪造整套 WebRTC 接口；同时也让 ws-client 在没有 DOM 的宿主里可被 import。

import type { RTCDataChannelLike } from './data-channel-carrier';

export interface SessionDescriptionLike {
  type: string;
  sdp: string;
}

export interface IceCandidateLike {
  candidate: string;
  sdpMid: string | null;
}

/** `RTCStatsReport` 是 Map-like，只用到 `forEach`。 */
export interface StatsReportLike {
  forEach(cb: (report: Record<string, unknown>) => void): void;
}

export interface RTCPeerConnectionLike {
  /** `RTCSctpTransport`：只用 `maxMessageSize` 决定分片载荷。 */
  readonly sctp?: { readonly maxMessageSize?: number } | null;
  readonly localDescription: SessionDescriptionLike | null;
  readonly remoteDescription: SessionDescriptionLike | null;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  onicecandidate: ((event: { candidate: IceCandidateLike | null }) => void) | null;
  onconnectionstatechange: ((event?: unknown) => void) | null;
  oniceconnectionstatechange: ((event?: unknown) => void) | null;
  createDataChannel(label: string, init?: { ordered?: boolean }): RTCDataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description?: unknown): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  getStats(): Promise<StatsReportLike>;
  close(): void;
}

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RtcConfigurationLike {
  iceServers: IceServerLike[];
}

export type RtcPeerConnectionFactory = (config: RtcConfigurationLike) => RTCPeerConnectionLike;

/** `/mesh/ws` 上的 `RTC_SIGNAL` 载荷（与 `apps/fe/src/node/mesh-events.ts` 同形）。 */
export interface DirectSignalMessage {
  rtcSession: string;
  from: 'browser' | 'node';
  to: string;
  sdp: string | null;
  candidate: string | null;
}

/**
 * 注入的信令通道：控制器不认识 `/mesh/ws`，只认识这几个方法。
 *
 * `send` 必须**如实返回是否送出**（`/mesh/ws` 未连接时为 `false`）：吞掉失败会让 offer /
 * candidate 静默丢失，控制器只能干等超时。`isReady` / `onReady` 可选——没有实现时控制器
 * 视为始终就绪（老实现零改动），实现了则未就绪期间不开新 attempt、信令排队、恢复即重试。
 */
export interface DirectSignalingTransport {
  send(signal: DirectSignalMessage): boolean | Promise<boolean>;
  onSignal(cb: (signal: DirectSignalMessage) => void): () => void;
  isReady?(): boolean;
  onReady?(cb: (ready: boolean) => void): () => void;
}

/** `ApiClient` 的最小子集（node 前缀已由调用方注入）。 */
export interface DirectApiClientLike {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** `GET /api/mesh/rtc-config` 的响应。 */
export interface RtcConfigResponse {
  stun?: unknown;
  turn?: unknown;
}

/** `POST /api/rtc/authorize` 的响应。 */
export interface RtcAuthorizeResponse {
  nonce?: unknown;
  fp_node?: unknown;
}
