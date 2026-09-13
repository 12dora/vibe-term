import type { RelayQuota } from './codec';
import type { RelayLinkErrorCode } from './link-error';

/** 本机 uplink 的形态：接中继 / 接 hub / 都没有。 */
export type RelayUplinkMode = 'relay' | 'hub' | 'none';

export type RelayAttachRole = 'primary' | 'secondary';

export type RelayStatusTurnMembers = { ok: number; total: number; updatedAt: number };
export type RelayStatusTurnLocalHint = 'tun';

/** `GET /api/mesh/relay/status` 行上的 TURN 视图；旧节点不下发。 */
export type RelayStatusTurnView = {
  url: string;
  probeOk: boolean | null;
  members?: RelayStatusTurnMembers;
  localHint?: RelayStatusTurnLocalHint;
};

export type RelayStatusRowKeyLog = { diverged: true };

/** 最近一次主中继变更的原因；`manual` = 用户固定，`auto-*` = 自动优选，`startup` = 启动按 priority 挂上。 */
export type RelaySwitchReason =
  | 'manual'
  | 'auto-rtt'
  | 'auto-failover'
  | 'pin-failback'
  | 'enroll'
  | 'startup';

/** 自动优选（多中继时按上联 RTT 自动换主）的运行状态；旧节点不下发。 */
export type RelayAutoSelectView = {
  enabled: boolean;
  lastSwitchAt: number | null;
  switchReason: RelaySwitchReason | null;
  /** 下次评估的时间点；关闭或无候选时为 `null`。 */
  nextEvalAt: number | null;
};

/**
 * 中继列表里的一条链路（按 `priority` 升序即 failover 顺序）。
 * `GET /api/mesh/relay/status` 的 `relays[]` 元素；2.2.x 网关可能缺后加字段。
 */
export type RelayStatusRow = {
  url: string;
  priority: number;
  online: boolean;
  attached: boolean;
  /** 多中继同时挂载时的角色；未连接为 `null`。旧节点不下发。 */
  role?: RelayAttachRole | null;
  rttMs?: number | null;
  pathBestMs?: number;
  reraces?: number;
  peersOnline?: number | null;
  turn?: RelayStatusTurnView | null;
  /** 当前（未恢复的）连接错误原文；在线时为 `null`。 */
  lastError?: string | null;
  /** `lastError` 归一化后的稳定错误码；在线时为 `null`。 */
  lastErrorCode?: RelayLinkErrorCode | null;
  lastErrorAt?: number | null;
  kicked?: boolean;
  /** 踢出原因；`password_rotated` 表示令牌换代，等新的 `set-relays` 即可恢复。 */
  kickedReason?: string | null;
  keyLog?: RelayStatusRowKeyLog;
  /** 该行是用户固定的主中继（`relay.preferredUrl` 等于本行 url）。 */
  pinned?: boolean;
  /** 当前主中继由自动优选提升（而非固定/启动顺序）。只在 `role === 'primary'` 上为 true。 */
  autoSelected?: boolean;
  /** 自动优选打分（越小越好，单位 ms）；样本不足或未连接为 `null`。 */
  score?: number | null;
};

export type RelayKeyLogHealth = {
  skipped: number;
  blockedSeq: string | null;
  caughtUp: boolean;
};

/** `GET /api/mesh/relay/status` 网关产出形状（后加字段在旧节点上可能缺）。 */
export type RelayStatusPayload = {
  mode: string;
  tenantId: string | null;
  relays: RelayStatusRow[];
  metaEpoch: number;
  nodesViaRelay: number;
  multiAttach: boolean;
  reauthRequired: boolean;
  awaitingToken: boolean;
  readmitPending: number;
  metaKeyLagging: unknown;
  quota: RelayQuota | null;
  keyLog: RelayKeyLogHealth;
  /** 用户固定的主中继 url；未固定为 `null`。旧节点不下发。 */
  preferredUrl?: string | null;
  autoSelect?: RelayAutoSelectView;
};
