// 中继级运营限额：与「配额」分开的一层。
//
// 配额（`RelayQuota`）是**按租户**的，且会原样推给租户节点；这里的限额只作用于中继自身
// （最多接多少租户、全中继的总带宽、租户之间是否公平分配），绝不能混进 `relay.quota` 帧里。

/** 总带宽上限沿用单租户带宽的天花板：再高也超过任何单机网卡。 */
export const RELAY_LIMITS_MAX_BANDWIDTH = 10 * 1024 * 1024 * 1024;
export const RELAY_LIMITS_MAX_TENANTS = 65_536;

export type RelayLimits = {
  /** 最多容纳的租户数；`null` = 跟随默认（`effectiveMaxTenants`），要放开就显式设一个大值。 */
  maxTenants: number | null;
  /** 全中继转发速率上限（字节/秒）；`null` 不限。 */
  totalBandwidthBytesPerSec: number | null;
  /** 租户之间按轮转公平分配总带宽；关掉即先到先得。 */
  fairShare: boolean;
};

export const RELAY_DEFAULT_LIMITS: RelayLimits = {
  maxTenants: null,
  totalBandwidthBytesPerSec: null,
  fairShare: true,
};

const INVALID = Symbol('invalid');

function optionalPositiveInt(value: unknown, limit: number): number | null | typeof INVALID {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return INVALID;
  if (value < 1 || value > limit) return INVALID;
  return value;
}

/** 严格解析（HTTP 入参）：任何字段非法都返回 null，调用方回 400 `RELAY_BAD_LIMITS`。 */
export function normalizeRelayLimits(value: unknown): RelayLimits | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const maxTenants = optionalPositiveInt(rec.maxTenants, RELAY_LIMITS_MAX_TENANTS);
  if (maxTenants === INVALID) return null;
  const totalBandwidthBytesPerSec = optionalPositiveInt(
    rec.totalBandwidthBytesPerSec,
    RELAY_LIMITS_MAX_BANDWIDTH
  );
  if (totalBandwidthBytesPerSec === INVALID) return null;
  const fairShare = rec.fairShare;
  if (fairShare !== undefined && typeof fairShare !== 'boolean') return null;
  return {
    maxTenants,
    totalBandwidthBytesPerSec,
    fairShare: fairShare ?? RELAY_DEFAULT_LIMITS.fairShare,
  };
}

/** 实际生效的租户上限：未设置时用运行时默认值。 */
export function effectiveMaxTenants(limits: RelayLimits, defaultMaxTenants: number): number {
  return limits.maxTenants ?? defaultMaxTenants;
}

/** 启动时的配置告警：未设接入口令；存量租户已超默认上限而运营者没显式设上限。 */
export function relayStartupWarnings(input: {
  hasPassword: boolean;
  limits: RelayLimits;
  tenantCount: number;
  defaultMaxTenants: number;
}): string[] {
  const out: string[] = [];
  if (!input.hasPassword) {
    out.push(
      '[relay] warning: no relay access password is set; anyone can create tenants (up to the tenant limit). Set one with `vibeterm relay passwd`.'
    );
  }
  if (input.limits.maxTenants === null && input.tenantCount > input.defaultMaxTenants) {
    out.push(
      `[relay] warning: ${input.tenantCount} tenants exceed the default tenant limit ${input.defaultMaxTenants} and no max_tenants is configured; new tenants are refused until max_tenants (or VIBETERM_RELAY_MAX_TENANTS) is raised.`
    );
  }
  return out;
}

export function defaultRelayLimits(): RelayLimits {
  return { ...RELAY_DEFAULT_LIMITS };
}

/** 指标里的限额只读投影：`GET /api/relay/metrics` 的 totals 直接摊平这三项。 */
export type RelayLimitTotals = {
  /** 全中继带宽上限（字节/秒）；`null` 不限。 */
  bandwidthLimitBytesPerSec: number | null;
  maxTenants: number | null;
  fairShare: boolean;
};

export function relayLimitTotals(limits: RelayLimits, defaultMaxTenants: number): RelayLimitTotals {
  return {
    bandwidthLimitBytesPerSec: limits.totalBandwidthBytesPerSec,
    maxTenants: effectiveMaxTenants(limits, defaultMaxTenants),
    fairShare: limits.fairShare,
  };
}
