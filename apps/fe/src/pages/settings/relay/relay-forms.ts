// 中继运营面三个表单（默认配额 / 租户覆盖 / 接入口令）的草稿模型。
//
// 校验与拼装留在纯函数里，组件只负责把草稿摆出来：没有 DOM 测试环境，表单逻辑只能这样测。
// 错误字段存的是 i18n key，不是文案。

import type {
  RelayLimits,
  RelayPasswordMode,
  RelayPasswordRequest,
  RelayQuota,
  RelayTenantPatch,
} from '@vibeterm/api-client/relay/admin-api';
import { RELAY_LIMITS_BOUNDS, RELAY_QUOTA_LIMITS } from '@vibeterm/api-client/relay/admin-api';
import { bytesToKb, bytesToMb, kbToBytes, mbToBytes } from './relay-format';

/** 带宽字段用 KB/s 收，上限按服务端的字节上限折算。 */
export const BANDWIDTH_KB_LIMIT = Math.floor(RELAY_QUOTA_LIMITS.bandwidthBytesPerSec / 1024);
/** 单文件上限字段用 MB 收。 */
export const MAX_FILE_MB_LIMIT = Math.floor(RELAY_QUOTA_LIMITS.maxFileBytes / (1024 * 1024));
export const TOTAL_BANDWIDTH_KB_LIMIT = Math.floor(
  RELAY_LIMITS_BOUNDS.totalBandwidthBytesPerSec / 1024
);
export const MAX_TENANTS_LIMIT = RELAY_LIMITS_BOUNDS.maxTenants;

/**
 * 打开表单时的原始字节值，连同它渲染成的文本一起记下来。
 * KB/s 与 MB 都是取整后的展示值：512 B/s 会显示成 1 KB/s，原样提交回去就变成 1024 B/s。
 * 提交时若某个字段的文本没被改过，就把原始字节值原样送回，只有真被改过才做单位换算。
 */
export interface QuotaOrigin {
  bandwidthKb: string;
  bandwidthBytes: number | null;
  maxFileMb: string;
  maxFileBytes: number | null;
}

export interface QuotaDraft {
  maxNodes: string;
  maxStreams: string;
  bandwidthKb: string;
  /** 勾上即不限速，`bandwidthKb` 保留原值备切回。 */
  unlimited: boolean;
  /** 单文件上限（MB）；留空即不限。 */
  maxFileMb: string;
  origin?: QuotaOrigin;
}

export interface QuotaErrors {
  maxNodes?: string;
  maxStreams?: string;
  bandwidthKb?: string;
  maxFileMb?: string;
}

export type QuotaParseResult =
  | { quota: RelayQuota; errors: null }
  | { quota: null; errors: QuotaErrors };

export const PASSWORD_MIN_LENGTH = 8;

export function quotaToDraft(quota: RelayQuota): QuotaDraft {
  const bandwidthKb =
    quota.bandwidthBytesPerSec === null ? '' : String(bytesToKb(quota.bandwidthBytesPerSec));
  const maxFileMb = quota.maxFileBytes == null ? '' : String(bytesToMb(quota.maxFileBytes));
  return {
    maxNodes: String(quota.maxNodes),
    maxStreams: String(quota.maxStreams),
    bandwidthKb,
    unlimited: quota.bandwidthBytesPerSec === null,
    maxFileMb,
    origin: {
      bandwidthKb,
      bandwidthBytes: quota.bandwidthBytesPerSec,
      maxFileMb,
      maxFileBytes: quota.maxFileBytes ?? null,
    },
  };
}

/** 文本与打开表单时一致就返回原始字节值，否则按 `convert` 换算。 */
function keptOrConverted(
  text: string,
  originText: string | undefined,
  originBytes: number | null | undefined,
  convert: () => number
): number {
  if (originText !== undefined && originBytes != null && text.trim() === originText.trim()) {
    return originBytes;
  }
  return convert();
}

/**
 * 正整数且落在服务端的允许区间内：允许前后空白，拒绝小数、负数、指数与空串。
 * 越界的值服务端一律回 `400 RELAY_BAD_QUOTA`（`relay-quota.ts` 的 `normalizeRelayQuota`），
 * 与其让用户点了才知道，不如在字段上直接说清楚。
 */
function boundedInteger(raw: string, limit: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 && value <= limit ? value : null;
}

export function parseQuotaDraft(draft: QuotaDraft): QuotaParseResult {
  const errors: QuotaErrors = {};
  const maxNodes = boundedInteger(draft.maxNodes, RELAY_QUOTA_LIMITS.maxNodes);
  if (maxNodes === null) errors.maxNodes = 'relay.admin.quota.invalidNodes';
  const maxStreams = boundedInteger(draft.maxStreams, RELAY_QUOTA_LIMITS.maxStreams);
  if (maxStreams === null) errors.maxStreams = 'relay.admin.quota.invalidStreams';

  let bandwidthBytesPerSec: number | null = null;
  if (!draft.unlimited) {
    const kb = boundedInteger(draft.bandwidthKb, BANDWIDTH_KB_LIMIT);
    if (kb === null) errors.bandwidthKb = 'relay.admin.quota.invalidBandwidth';
    else {
      bandwidthBytesPerSec = keptOrConverted(
        draft.bandwidthKb,
        draft.origin?.bandwidthKb,
        draft.origin?.bandwidthBytes,
        () => kbToBytes(kb)
      );
    }
  }

  // 留空 = 不限；填了就必须是合法整数。
  let maxFileBytes: number | null = null;
  if (draft.maxFileMb.trim() !== '') {
    const mb = boundedInteger(draft.maxFileMb, MAX_FILE_MB_LIMIT);
    if (mb === null) errors.maxFileMb = 'relay.admin.quota.invalidMaxFile';
    else {
      maxFileBytes = keptOrConverted(
        draft.maxFileMb,
        draft.origin?.maxFileMb,
        draft.origin?.maxFileBytes,
        () => mbToBytes(mb)
      );
    }
  }

  if (Object.keys(errors).length > 0 || maxNodes === null || maxStreams === null) {
    return { quota: null, errors };
  }
  return { quota: { maxNodes, maxStreams, bandwidthBytesPerSec, maxFileBytes }, errors: null };
}

export function quotaEquals(a: RelayQuota, b: RelayQuota): boolean {
  return (
    a.maxNodes === b.maxNodes &&
    a.maxStreams === b.maxStreams &&
    a.bandwidthBytesPerSec === b.bandwidthBytesPerSec &&
    (a.maxFileBytes ?? null) === (b.maxFileBytes ?? null)
  );
}

// ---------------------------------------------------------------------------
// 中继限额
// ---------------------------------------------------------------------------

export interface LimitsOrigin {
  totalBandwidthKb: string;
  totalBandwidthBytes: number | null;
}

export interface LimitsDraft {
  /** 留空即不限。 */
  maxTenants: string;
  /** 总带宽上限（KB/s）；留空即不限。 */
  totalBandwidthKb: string;
  fairShare: boolean;
  /** 见 `QuotaOrigin`：没被改过的带宽字段原样回传，不被 KB/s 取整改写。 */
  origin?: LimitsOrigin;
}

export interface LimitsErrors {
  maxTenants?: string;
  totalBandwidthKb?: string;
}

export type LimitsParseResult =
  | { limits: RelayLimits; errors: null }
  | { limits: null; errors: LimitsErrors };

export function limitsToDraft(limits: RelayLimits | undefined): LimitsDraft {
  const totalBandwidthKb =
    limits?.totalBandwidthBytesPerSec == null
      ? ''
      : String(bytesToKb(limits.totalBandwidthBytesPerSec));
  return {
    maxTenants: limits?.maxTenants == null ? '' : String(limits.maxTenants),
    totalBandwidthKb,
    fairShare: limits?.fairShare !== false,
    origin: {
      totalBandwidthKb,
      totalBandwidthBytes: limits?.totalBandwidthBytesPerSec ?? null,
    },
  };
}

export function parseLimitsDraft(draft: LimitsDraft): LimitsParseResult {
  const errors: LimitsErrors = {};
  let maxTenants: number | null = null;
  if (draft.maxTenants.trim() !== '') {
    const parsed = boundedInteger(draft.maxTenants, MAX_TENANTS_LIMIT);
    if (parsed === null) errors.maxTenants = 'relay.admin.limits.invalidMaxTenants';
    else maxTenants = parsed;
  }
  let totalBandwidthBytesPerSec: number | null = null;
  if (draft.totalBandwidthKb.trim() !== '') {
    const kb = boundedInteger(draft.totalBandwidthKb, TOTAL_BANDWIDTH_KB_LIMIT);
    if (kb === null) errors.totalBandwidthKb = 'relay.admin.limits.invalidBandwidth';
    else {
      totalBandwidthBytesPerSec = keptOrConverted(
        draft.totalBandwidthKb,
        draft.origin?.totalBandwidthKb,
        draft.origin?.totalBandwidthBytes,
        () => kbToBytes(kb)
      );
    }
  }
  if (Object.keys(errors).length > 0) return { limits: null, errors };
  return {
    limits: { maxTenants, totalBandwidthBytesPerSec, fairShare: draft.fairShare },
    errors: null,
  };
}

// ---------------------------------------------------------------------------
// 租户覆盖
// ---------------------------------------------------------------------------

export interface TenantDraft {
  /** 跟随默认配额：提交时发 `quota: null`。 */
  inherit: boolean;
  label: string;
  quota: QuotaDraft;
}

export type TenantParseResult =
  | { patch: RelayTenantPatch; errors: null }
  | { patch: null; errors: QuotaErrors };

/** 租户没有自己的配额时，草稿用默认值预填——用户一取消勾选就能在此基础上改。 */
export function tenantToDraft(
  tenant: { label: string | null; quota: RelayQuota | null },
  defaultQuota: RelayQuota
): TenantDraft {
  return {
    inherit: tenant.quota === null,
    label: tenant.label ?? '',
    quota: quotaToDraft(tenant.quota ?? defaultQuota),
  };
}

export function parseTenantDraft(draft: TenantDraft): TenantParseResult {
  const label = draft.label.trim();
  if (draft.inherit)
    return { patch: { quota: null, label: label === '' ? null : label }, errors: null };
  const parsed = parseQuotaDraft(draft.quota);
  if (parsed.quota === null) return { patch: null, errors: parsed.errors };
  return { patch: { quota: parsed.quota, label: label === '' ? null : label }, errors: null };
}

// ---------------------------------------------------------------------------
// 接入口令
// ---------------------------------------------------------------------------

export interface PasswordDraft {
  /** 清除口令：清除后任何人都能接入。 */
  clear: boolean;
  password: string;
  mode: RelayPasswordMode;
}

export type PasswordParseResult =
  | { body: RelayPasswordRequest; error: null }
  | { body: null; error: string };

export function emptyPasswordDraft(): PasswordDraft {
  // 默认「保留」：改口令多数时候只是换一把新的，不该顺手把在线租户全踢掉。
  return { clear: false, password: '', mode: 'keep' };
}

export function parsePasswordDraft(draft: PasswordDraft): PasswordParseResult {
  if (draft.clear) return { body: { password: null, mode: draft.mode }, error: null };
  if (draft.password.length < PASSWORD_MIN_LENGTH) {
    return { body: null, error: 'relay.admin.password.tooShort' };
  }
  return { body: { password: draft.password, mode: draft.mode }, error: null };
}
