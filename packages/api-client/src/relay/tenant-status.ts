// `GET /api/mesh/relay/status` 的读侧归一化。
//
// 后加的字段（多挂载、TURN、固定 / 自动优选）在 2.2.x 网关上一概缺席，这里一律补成确定值而不是
// `undefined`：前端那份 store 是就地合并的，缺席会让界面把上一份状态一直画下去。

import type {
  RelayAutoSelectView,
  RelayKeyLogHealth,
  RelaySwitchReason,
} from '@vibeterm/shared/relay';
import { normalizeMetaKeyLagging } from './meta-key-lagging';
import type { RelayLinkStatus, RelayTenantStatus, RelayTenantStatusWire } from './tenant-api';
import { normalizeRelayTurn } from './tenant-turn';

const SWITCH_REASONS: readonly RelaySwitchReason[] = [
  'manual',
  'auto-rtt',
  'auto-failover',
  'pin-failback',
  'enroll',
  'startup',
];

/** 共享空值一律冻结：这些常量会被原样返回给多个调用方，谁就地改一下所有人都跟着变。 */
const AUTO_SELECT_OFF: RelayAutoSelectView = Object.freeze({
  enabled: false,
  lastSwitchAt: null,
  switchReason: null,
  nextEvalAt: null,
});

const EMPTY_KEY_LOG: RelayKeyLogHealth = Object.freeze({
  skipped: 0,
  blockedSeq: null,
  caughtUp: false,
});

/** `never[]` 才能同时当空的 `relays` 与 `metaKeyLagging` 用。 */
const EMPTY_LIST = Object.freeze([]) as never[];

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 自动优选视图；旧网关整个字段都不下发时落成「未开启」。 */
function normalizeAutoSelect(view: RelayAutoSelectView | undefined): RelayAutoSelectView {
  if (!view || typeof view !== 'object') return AUTO_SELECT_OFF;
  const reason = view.switchReason;
  return {
    enabled: view.enabled === true,
    lastSwitchAt: finiteOrNull(view.lastSwitchAt),
    switchReason: reason && SWITCH_REASONS.includes(reason) ? reason : null,
    nextEvalAt: finiteOrNull(view.nextEvalAt),
  };
}

/** 在线时抹掉残留的错误三件套：链路已经恢复，旧错误再摆出来就是假告警。 */
function rowError(
  row: RelayLinkStatus
): Pick<RelayLinkStatus, 'lastError' | 'lastErrorCode' | 'lastErrorAt'> {
  if (row.online === true) return { lastError: null, lastErrorCode: null, lastErrorAt: null };
  return {
    lastError: row.lastError ?? null,
    lastErrorCode: row.lastErrorCode ?? null,
    lastErrorAt: row.lastErrorAt ?? null,
  };
}

/** 被踢才有原因可说。 */
function rowKick(row: RelayLinkStatus): Pick<RelayLinkStatus, 'kicked' | 'kickedReason'> {
  if (row.kicked !== true) return { kicked: false, kickedReason: null };
  return { kicked: true, kickedReason: row.kickedReason ?? null };
}

/** 路径抽样是可选的：缺席与 0 是两回事，不能补默认值。 */
function rowPath(row: RelayLinkStatus): Pick<RelayLinkStatus, 'pathBestMs' | 'reraces'> {
  return {
    ...(typeof row.pathBestMs === 'number' ? { pathBestMs: row.pathBestMs } : {}),
    ...(typeof row.reraces === 'number' ? { reraces: row.reraces } : {}),
  };
}

function rowEnrollPassword(row: RelayLinkStatus): RelayLinkStatus['enrollPassword'] {
  return { known: row.enrollPassword?.known === true };
}

/** 一条链路：未知的角色一律 `null`，固定 / 自动优选 / 打分按缺席落成确定值。 */
function normalizeRelayRow(row: RelayLinkStatus): RelayLinkStatus {
  return {
    url: row.url,
    priority: row.priority ?? 0,
    online: row.online === true,
    attached: row.attached === true,
    role: row.role === 'primary' || row.role === 'secondary' ? row.role : null,
    rttMs: row.rttMs ?? null,
    ...rowPath(row),
    peersOnline: typeof row.peersOnline === 'number' ? row.peersOnline : null,
    turn: normalizeRelayTurn(row.turn),
    ...rowError(row),
    ...rowKick(row),
    pinned: row.pinned === true,
    autoSelected: row.autoSelected === true,
    score: finiteOrNull(row.score),
    enrollPassword: rowEnrollPassword(row),
  };
}

/** 密钥日志同步健康度；旧节点整块不下发。 */
function normalizeKeyLog(keyLog: RelayTenantStatusWire['keyLog']): RelayKeyLogHealth {
  if (!keyLog) return { skipped: 0, blockedSeq: null, caughtUp: false };
  return {
    skipped: keyLog.skipped ?? 0,
    blockedSeq: keyLog.blockedSeq ?? null,
    caughtUp: keyLog.caughtUp === true,
  };
}

/** 配额：旧中继不下发实时用量。 */
function normalizeQuota(
  quota: RelayTenantStatusWire['quota'] | undefined
): RelayTenantStatusWire['quota'] {
  return quota ? { ...quota, usage: quota.usage ?? null } : null;
}

function pinnedUrl(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const EMPTY_STATUS: RelayTenantStatus = Object.freeze({
  quota: null,
  mode: 'none',
  tenantId: null,
  relays: EMPTY_LIST,
  metaEpoch: 0,
  nodesViaRelay: 0,
  multiAttach: false,
  reauthRequired: false,
  awaitingToken: false,
  keyLog: EMPTY_KEY_LOG,
  readmitPending: 0,
  metaKeyLagging: EMPTY_LIST,
  preferredUrl: null,
  autoSelect: AUTO_SELECT_OFF,
});

/** 缺字段一律补默认值：旧节点没有这条路由，`mode` 之外的字段也可能是后加的。 */
export function normalizeRelayStatus(
  payload: Partial<RelayTenantStatusWire> | null
): RelayTenantStatus {
  if (!payload) return EMPTY_STATUS;
  return {
    quota: normalizeQuota(payload.quota),
    mode: payload.mode ?? 'none',
    tenantId: payload.tenantId ?? null,
    relays: (payload.relays ?? []).map(normalizeRelayRow),
    metaEpoch: payload.metaEpoch ?? 0,
    nodesViaRelay: payload.nodesViaRelay ?? 0,
    multiAttach: payload.multiAttach === true,
    reauthRequired: payload.reauthRequired === true,
    awaitingToken: payload.awaitingToken === true,
    keyLog: normalizeKeyLog(payload.keyLog),
    readmitPending: payload.readmitPending ?? 0,
    metaKeyLagging: normalizeMetaKeyLagging(payload.metaKeyLagging),
    preferredUrl: pinnedUrl(payload.preferredUrl),
    autoSelect: normalizeAutoSelect(payload.autoSelect),
  };
}
