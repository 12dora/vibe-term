// Mesh 节点行契约：`GET /api/mesh/nodes` 单行、NODE_EVENT 字段、CLI 列共用这一份。
// 直连失败码是对外契约（`nodes.badge.failure.<code>`），改动必须连带改三语文案。

import type { MeshPortReachCode, PortPurpose, PortRange } from '../net/port-plan';
import type { MeshNodeOperation } from './system';

export type MeshNodeReach = 'lan' | 'wan' | 'relay' | null;
export type MeshNodeTransport = 'ws-secure' | 'relay' | 'dc' | null;

export const DIRECT_FAILURE_CODES = [
  'timeout',
  'refused',
  'unreachable',
  'reset',
  'tls',
  'handshake',
  'revoked',
  'untrusted',
  'backoff',
  'no_endpoints',
  'ice_failed',
  'no_candidates',
  'dc_open_timeout',
  'dc_closed',
  'liveness_timeout',
  'signal_dropped',
  'signaling_state',
  'rtc_unavailable',
  'not_direct_capable',
  'breaker_cooling',
  /** 熔断生效但没有解除时刻（永久禁拨）：`breaker_cooling` 的模板要 `{{until}}`，不能复用。 */
  'breaker_paused',
  'aborted',
  'no_srflx',
  'stun_unconfigured',
  'other',
] as const;

export type DirectFailureCode = (typeof DIRECT_FAILURE_CODES)[number];

/** `wsCode` 的插值参数：`backoff` 带 `seconds`，其余带发起过的 `url`。 */
export interface DirectFailureWsParams {
  url?: string;
  seconds?: number;
}

/** `dcCode` 的插值参数：`breaker_cooling` 带熔断解除时刻（epoch 毫秒）。 */
export interface DirectFailureDcParams {
  until?: number;
}

/** 最近一次直连尝试的失败原因（按承载分开记）；从未尝试为 `null`。 */
export interface MeshNodeDirectFailure {
  /** 记录时刻（epoch 毫秒）。 */
  at: number;
  /** ws 直连的失败原因原文，形如 `timeout ws://10.110.88.3:39001/peer`。 */
  ws?: string | null;
  /** ws 失败的分类码；旧网关不下发。 */
  wsCode?: DirectFailureCode | null;
  wsParams?: DirectFailureWsParams | null;
  /** DataChannel 直连的失败原因原文，形如 `datachannel open timeout`。 */
  dc?: string | null;
  /** DataChannel 失败的分类码；旧网关不下发。 */
  dcCode?: DirectFailureCode | null;
  dcParams?: DirectFailureDcParams | null;
}

/** DataChannel 拨号熔断器快照；未尝试或旧后端不下发。 */
export interface MeshNodeDcBreaker {
  cooling: boolean;
  until: number | null;
  failures: number;
  level: number;
  lastFailureKind: string | null;
}

export type MeshPortReach = {
  purpose: PortPurpose;
  proto: 'tcp' | 'udp';
  port?: number;
  range?: PortRange;
  status: 'open' | 'blocked' | 'unknown';
  code?: MeshPortReachCode;
  checkedAt?: number;
};

/** `GET /api/mesh/nodes` 的单行（**需会话**）。 */
export interface MeshNode {
  id: string;
  name: string;
  /** base64url，32 字节 */
  publicKey: string;
  online: boolean;
  /**
   * entry ↔ node 的到达路径：`lan`（对端地址为私网/本机）、`wan`（公网直连）、
   * `relay`（relayed / forwarded）、null（不可达）。
   */
  reach: MeshNodeReach;
  /** 实际 peer link 承载。 */
  transport?: MeshNodeTransport;
  /** entry ↔ node 最近一次 ping/pong 往返毫秒数；未测得为 null。 */
  rttMs?: number | null;
  /** `transport==='relay'` 时实际经过的中继公网 URL；直连或未知为缺省 / null。 */
  viaRelay?: string | null;
  /** 对端当前在线的中继 URL；多中继下可能为空数组。 */
  relayPresence?: string[];
  /** 当前链路的对端地址：`ws-secure` / `dc` 为对端主机，`relay` 为中继主机；未知为 null。 */
  peerAddress?: string | null;
  /** 当前这条链路建立的时刻（epoch 毫秒）；未知为 null。 */
  linkSinceAt?: number | null;
  /** peer_cache.last_seen_at（毫秒）；self 恒 null。旧入口不下发。 */
  lastSeenAt?: number | null;
  /** 对端广播的 ws 接入地址。 */
  endpoints?: string[];
  /** 最近一次直连尝试的失败原因；已直连或从未尝试为 null。 */
  directFailure?: MeshNodeDirectFailure | null;
  /** DataChannel 熔断器；冷却期间不再自动拨 DC。旧后端不下发。 */
  dcBreaker?: MeshNodeDcBreaker | null;
  version: string | null;
  direct_capable: boolean;
  inventory?: unknown;
  loggedIn: boolean;
  /** 入口记录的进行中长事务（卸载）；无则缺省或 null。 */
  operation?: MeshNodeOperation | null;
  /** 入口本机暂停了该成员。缺省 / 旧网关 / self 视为 false。 */
  paused?: boolean;
  ports?: MeshPortReach[];
}
