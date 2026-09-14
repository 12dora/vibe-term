import type { WebSocketTransportInput } from '@vibeterm/shared/link';
import type { UserStore } from '../auth/user-store';
import { createDialWsFactory } from './dial-resolve';
import type {
  KeyLogApplier,
  KeyLogForkEvent,
  MeshIdentity,
  MeshScheduler,
  UplinkStatus,
} from './types';
import type { UplinkEnrollRedeemed, UplinkNodeList, UplinkRtcSignal } from './uplink-protocol';
import { classifyUplinkConnectError } from './uplink-reconnect';
import type { WsDialContext } from './ws-open-race';

export { classifyUplinkConnectError };
export { createDialWsFactory as defaultWsFactory };

export const UPLINK_PING_INTERVAL_MS = 15_000;
export const UPLINK_MISSED_PONG_LIMIT = 3;
export const UPLINK_BACKOFF_MIN_MS = 1_000;
export const UPLINK_BACKOFF_MAX_MS = 60_000;
export const UPLINK_CONNECT_TIMEOUT_MS = 20_000;
export const UPLINK_AUTH_TIMEOUT_MS = 10_000;
export const UPLINK_STABLE_UPTIME_MS = 30_000;
export const UPLINK_KEY_LOG_ACK_TIMEOUT_MS = 10_000;
export const UPLINK_KEY_LOG_RETRY_LIMIT = 3;
export const UPLINK_CTL_WARN_INTERVAL_MS = 5_000;
export const UPLINK_CONNECT_LOG_INTERVAL_MS = 30_000;

export type UplinkWsFactory = (
  url: string,
  ctx?: WsDialContext
) => WebSocketTransportInput | Promise<WebSocketTransportInput>;

export type UplinkClientOptions = {
  uplinkUrl: string;
  identity: MeshIdentity;
  userId: string | (() => string);
  keyLogApplier: KeyLogApplier;
  userStore: UserStore;
  statusProvider: () => UplinkStatus;
  onNodeList?: (list: UplinkNodeList) => void;
  onRtcSignal?: (msg: UplinkRtcSignal) => void;
  onEnrollRedeemed?: (msg: UplinkEnrollRedeemed) => void;
  onKeyLogFork?: (event: KeyLogForkEvent) => void;
  wsFactory?: UplinkWsFactory;
  tlsCa?: string[] | null;
  scheduler?: MeshScheduler;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  keyLogTimeoutMs?: number;
  keyLogRetryLimit?: number;
  /** 中继 secondary：catch-up 只向已验证前缀补推，不经 sendCtl 发布新记录。 */
  keyLogCatchUp?: 'publish' | 'prefix-verified';
};

export function uplinkWebSocketTls(
  tlsCa: string[] | null | undefined
): { tls: { ca: string[] } } | undefined {
  return tlsCa && tlsCa.length > 0 ? { tls: { ca: tlsCa } } : undefined;
}
