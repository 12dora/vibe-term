export interface RelayQuotaUsageView {
  currentNodes?: number;
  currentStreams?: number;
  bytesInPerSec?: number;
  bytesOutPerSec?: number;
  bandwidthBytesPerSec?: number;
}

export interface RelayQuotaView {
  maxNodes?: number;
  maxStreams?: number;
  bandwidthBytesPerSec?: number | null;
  maxFileBytes?: number | null;
  currentNodes?: number;
  usage?: RelayQuotaUsageView | null;
}

const UNLIMITED = '∞';

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countPair(used: number | null, limit: number | null): string {
  const cap = limit !== null && limit > 0 ? String(limit) : UNLIMITED;
  return `${used === null ? '-' : String(used)}/${cap}`;
}

function asKbPerSec(bytesPerSec: number): string {
  const kb = bytesPerSec / 1024;
  return Number.isInteger(kb) ? String(kb) : String(Math.round(kb * 10) / 10);
}

function asMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? String(mb) : String(Math.round(mb * 10) / 10);
}

function bandwidthUsedOf(quota: RelayQuotaView): number | null {
  const usage = quota.usage ?? null;
  if (!usage) return null;
  const combined = finiteNumber(usage.bandwidthBytesPerSec);
  if (combined !== null) return combined;
  const inbound = finiteNumber(usage.bytesInPerSec) ?? 0;
  const outbound = finiteNumber(usage.bytesOutPerSec) ?? 0;
  if (usage.bytesInPerSec === undefined && usage.bytesOutPerSec === undefined) return null;
  return Math.max(inbound, outbound);
}

function bandwidthLimitOf(quota: RelayQuotaView): number | null {
  const limit = finiteNumber(quota.bandwidthBytesPerSec);
  if (limit === null || limit <= 0) return null;
  return limit;
}

function quotaFromUnknown(value: unknown): RelayQuotaView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as RelayQuotaView;
}

function bandwidthPair(quota: RelayQuotaView): string {
  const used = bandwidthUsedOf(quota);
  const limit = bandwidthLimitOf(quota);
  if (used === null && limit === null) return UNLIMITED;
  return `${used === null ? '-' : asKbPerSec(used)}/${limit === null ? UNLIMITED : asKbPerSec(limit)}`;
}

export function formatRelayQuotaLine(url: string, quota: RelayQuotaView): string {
  const usage = quota.usage ?? null;
  const nodesUsed = finiteNumber(usage?.currentNodes) ?? finiteNumber(quota.currentNodes);
  const streamsUsed = finiteNumber(usage?.currentStreams);
  const maxFile = quota.maxFileBytes === null ? null : finiteNumber(quota.maxFileBytes);
  const file = maxFile === null ? UNLIMITED : asMb(maxFile);
  return `quota ${url}: nodes ${countPair(nodesUsed, finiteNumber(quota.maxNodes))}  streams ${countPair(streamsUsed, finiteNumber(quota.maxStreams))}  bandwidth ${bandwidthPair(quota)} KB/s  max-file ${file} MB`;
}

export function formatRelayQuotaLines(
  quota: unknown,
  relays: readonly { url: string; quota?: unknown }[],
  fallbackUrl = '-'
): string[] {
  const top = quotaFromUnknown(quota);
  if (!top && relays.every((row) => quotaFromUnknown(row.quota) === null)) return [];
  if (relays.length === 0) {
    if (!top) return [];
    return [formatRelayQuotaLine(fallbackUrl, top)];
  }
  const lines: string[] = [];
  for (const row of relays) {
    const rowQuota = quotaFromUnknown(row.quota) ?? top;
    if (!rowQuota) continue;
    lines.push(formatRelayQuotaLine(row.url, rowQuota));
  }
  return lines;
}
