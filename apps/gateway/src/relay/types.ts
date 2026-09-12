import type { StunEnvSource } from '@vibeterm/shared/net';
import type { RelayQuota, RelayRtcConfig } from '@vibeterm/shared/relay';
import type { RelayPreviousToken } from './relay-token-grace';
import type { TurnPortRange } from './relay-turn-config';

export const RELAY_UPLINK_PATH = '/relay/uplink';
export const RELAY_UPLINK_WS_KIND = 'relay-uplink';

export const RELAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const RELAY_HEARTBEAT_MISS_LIMIT = 3;
export const RELAY_AUTH_TIMEOUT_MS = 10_000;
/** `relay.list` 广播防抖：同一租户内的连续变更合并成一帧。 */
export const RELAY_LIST_DEBOUNCE_MS = 100;
/** 计量落库间隔；停机时也会强制刷一次。 */
export const RELAY_METER_FLUSH_MS = 30_000;
export const RELAY_STOP_DRAIN_TIMEOUT_MS = 5_000;
export const RELAY_CTL_QUEUE_MAX = 256;
export const RELAY_CTL_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const RELAY_ENROLLMENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
/** 每租户同时存在的「未过期未使用」enrollment 上限。 */
export const RELAY_MAX_UNUSED_ENROLLMENTS = 32;
/** 每租户 `relay.enroll.create` 频率闸：窗口内最多创建这么多条。 */
export const RELAY_ENROLL_CREATE_LIMIT = 16;
export const RELAY_ENROLL_CREATE_WINDOW_MS = 60_000;
/** 已使用的 enrollment 行保留多久后清掉（随计量刷盘一起扫）。 */
export const RELAY_ENROLLMENT_USED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RELAY_METRICS_INTERVAL_MS = 5_000;
export const RELAY_METRICS_HISTORY_LIMIT = 60;

/** enroll 口令错误的按 IP 限速：15 分钟内 5 次失败即拒。 */
export const RELAY_ENROLL_FAILURE_LIMIT = 5;
export const RELAY_ENROLL_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * 令牌换发后上一代令牌的宽限期：新令牌要经密钥日志（`set-relays`）才到得了成员节点，
 * 换发的那一刻就作废旧令牌会让成员在拉到新记录之前先被踢下线，从而永远拉不到。
 */
export const RELAY_PREV_TOKEN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export const RELAY_TENANT_ID_BYTES = 16;
export const RELAY_TOKEN_BYTES = 32;
export const RELAY_ADMIN_TOKEN_BYTES = 32;

export const RELAY_DEFAULT_QUOTA: RelayQuota = {
  maxNodes: 16,
  maxStreams: 64,
  bandwidthBytesPerSec: null,
  maxFileBytes: null,
};

export type RelayRuntimeConfig = {
  /** 中继对外地址；uplink 签名绑定其 host，redeem 时作为 `relays` 下发。 */
  publicUrl: string;
  stun: string[];
  stunSource?: StunEnvSource;
  turn?: RelayRtcConfig['turn'];
  turnUrl?: string | null;
  turnUsername?: string | null;
  turnCredential?: string | null;
  /** 未传 = 测试默认不启内置 TURN；`0` 关闭；正数为监听端口。 */
  turnPort?: number;
  turnRelayPortRange?: TurnPortRange;
  turnExternalIp?: string | null;
  turnHost?: string | null;
  /** `auto` | `0.0.0.0` | IPv4。缺省 `auto`（本机主出口地址）。 */
  turnBindHost?: string | null;
  rtcPortRange?: TurnPortRange | null;
  peerPort?: number;
  /** `VIBETERM_RELAY_ADMIN_TOKEN`；缺失时首启生成。 */
  adminToken?: string | null;
  version?: string;
};

export type RelayTenantRecord = {
  id: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  tokenHash: string;
  tokenEpoch: number;
  /** 上一代令牌的哈希：非踢出场景换发时保留，宽限期内仍可认证。 */
  prevTokenHash: string | null;
  prevTokenIssuedAt: number | null;
  previousTokens?: RelayPreviousToken[];
  quota: RelayQuota | null;
  label: string | null;
  kicked: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  bytesIn: number;
  bytesOut: number;
  keyLogHeadSeq: bigint;
  kdfParamsJson: string | null;
  sealedPack: Uint8Array | null;
  sealedPackUpdatedAt: number | null;
};

export type RelayNodeStatusValue = 'pending' | 'admitted' | 'revoked';

export type RelayNodeRecord = {
  tenantId: string;
  nodeId: string;
  edPk: Uint8Array;
  x25519Pk: Uint8Array;
  status: RelayNodeStatusValue;
  admitSeq: number | null;
  lastSeenAt: number | null;
  protoVersion: number | null;
  clientVersion: string | null;
  createdAt: number;
};

export type RelayEnrollmentRecord = {
  id: string;
  tenantId: string;
  enrollPk: Uint8Array;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
  expiresAt: number;
  usedAt: number | null;
  nodeId: string | null;
  createdAt: number;
};

export type RelayKeyLogRow = {
  seq: bigint;
  blob: string;
};

export type RelayUpgradeServer = {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
};

export type RelayUplinkSocketData = {
  kind: typeof RELAY_UPLINK_WS_KIND;
};

export type RelayServerWebSocket = {
  data: RelayUplinkSocketData & { adapter?: { dispatchMessage(data: unknown): void } };
  send(data: Uint8Array | ArrayBuffer | ArrayBufferView | string): number | undefined;
  close(code?: number, reason?: string): void;
  getBufferedAmount?(): number;
};
