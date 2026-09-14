import { compareSemver } from '@vibeterm/shared';

export function normalizeReportedNodeVersion(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim().replace(/_dev$/, '');
  return trimmed.length > 0 ? trimmed : null;
}

export function nodeVersionMeets(raw: string | null | undefined, minVersion: string): boolean {
  const version = normalizeReportedNodeVersion(raw);
  if (!version) return false;
  const cmp = compareSemver(version, minVersion);
  return cmp !== null && cmp >= 0;
}
