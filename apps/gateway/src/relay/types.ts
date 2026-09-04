import type { RelayQuota, RelayRtcConfig } from '@tmex/shared/relay';

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

export const RELAY_TENANT_ID_BYTES = 16;
export const RELAY_TOKEN_BYTES = 32;
export const RELAY_ADMIN_TOKEN_BYTES = 32;

export const RELAY_DEFAULT_QUOTA: RelayQuota = {
  maxNodes: 16,
  maxStreams: 64,
  bandwidthBytesPerSec: null,
};

export type RelayRuntimeConfig = {
  /** 中继对外地址；uplink 签名绑定其 host，redeem 时作为 `relays` 下发。 */
  publicUrl: string;
  stun: string[];
  turn?: RelayRtcConfig['turn'];
  /** `TMEX_RELAY_ADMIN_TOKEN`；缺失时首启生成。 */
  adminToken?: string | null;
  version?: string;
};

export type RelayTenantRecord = {
  id: string;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  tokenHash: string;
  tokenEpoch: number;
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
