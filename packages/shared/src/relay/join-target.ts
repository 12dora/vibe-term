import type { RelayAttachRole } from './status-row';

export type RelayJoinTargetRow = {
  url: string;
  tenantId?: string | null;
  priority?: number;
  attached?: boolean;
  role?: RelayAttachRole | null;
  kicked?: boolean;
};

export type RelayJoinTarget = { url: string; tenantId: string | null };

/**
 * 给新机器执行 `relay join <url> --tenant <id>` 用的那一对值。
 *
 * 租户编号由每台中继各自签发，地址与编号必须出自同一行：优先当前主中继，其次任意已挂上的，
 * 再次 priority 最小且未被踢出的，最后才是 priority 最小的。旧网关不下发逐行编号，它的顶层 `tenantId` 属于 priority 最小的那一行，
 * 所以此时只能退回那一行，不能再拿它去配主中继的地址。
 */
export function pickRelayJoinTarget(
  rows: readonly RelayJoinTargetRow[],
  legacyTenantId?: string | null
): RelayJoinTarget | null {
  const ordered = rows
    .filter((row) => row.url)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const first = ordered[0];
  if (!first) return null;
  const current =
    ordered.find((row) => row.role === 'primary') ??
    ordered.find((row) => row.attached) ??
    ordered.find((row) => !row.kicked) ??
    first;
  if (current.tenantId) return { url: current.url, tenantId: current.tenantId };
  return { url: first.url, tenantId: first.tenantId || legacyTenantId || null };
}

/** 把 `preferredUrl` 对应的中继提到最前（新机器先试它），其余保持原顺序；不在名单里则原样返回。 */
export function preferRelayFirst<T extends { url: string }>(
  relays: readonly T[],
  preferredUrl?: string | null
): T[] {
  const index = preferredUrl ? relays.findIndex((relay) => relay.url === preferredUrl) : -1;
  if (index <= 0) return [...relays];
  return [relays[index], ...relays.slice(0, index), ...relays.slice(index + 1)];
}
