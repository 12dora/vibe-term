// 中继运营面三个表单（默认配额 / 租户覆盖 / 接入口令）的草稿模型。
//
// 校验与拼装留在纯函数里，组件只负责把草稿摆出来：没有 DOM 测试环境，表单逻辑只能这样测。
// 错误字段存的是 i18n key，不是文案。

import type {
  RelayPasswordMode,
  RelayPasswordRequest,
  RelayQuota,
  RelayTenantPatch,
} from '@tmex/api-client/relay/admin-api';
import { RELAY_QUOTA_LIMITS } from '@tmex/api-client/relay/admin-api';
import { bytesToKb, kbToBytes } from './relay-format';

/** 带宽字段用 KB/s 收，上限按服务端的字节上限折算。 */
export const BANDWIDTH_KB_LIMIT = Math.floor(RELAY_QUOTA_LIMITS.bandwidthBytesPerSec / 1024);

export interface QuotaDraft {
  maxNodes: string;
  maxStreams: string;
  bandwidthKb: string;
  /** 勾上即不限速，`bandwidthKb` 保留原值备切回。 */
  unlimited: boolean;
}

export interface QuotaErrors {
  maxNodes?: string;
  maxStreams?: string;
  bandwidthKb?: string;
}

export type QuotaParseResult =
  | { quota: RelayQuota; errors: null }
  | { quota: null; errors: QuotaErrors };

export const PASSWORD_MIN_LENGTH = 8;

export function quotaToDraft(quota: RelayQuota): QuotaDraft {
  return {
    maxNodes: String(quota.maxNodes),
    maxStreams: String(quota.maxStreams),
    bandwidthKb:
      quota.bandwidthBytesPerSec === null ? '' : String(bytesToKb(quota.bandwidthBytesPerSec)),
    unlimited: quota.bandwidthBytesPerSec === null,
  };
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
    else bandwidthBytesPerSec = kbToBytes(kb);
  }

  if (Object.keys(errors).length > 0 || maxNodes === null || maxStreams === null) {
    return { quota: null, errors };
  }
  return { quota: { maxNodes, maxStreams, bandwidthBytesPerSec }, errors: null };
}

export function quotaEquals(a: RelayQuota, b: RelayQuota): boolean {
  return (
    a.maxNodes === b.maxNodes &&
    a.maxStreams === b.maxStreams &&
    a.bandwidthBytesPerSec === b.bandwidthBytesPerSec
  );
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
