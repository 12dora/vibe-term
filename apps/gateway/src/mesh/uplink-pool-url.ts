import { canonicalHubUrl, hubHostFromUrl } from '@vibeterm/shared/auth';
import type { AttachedHub, UplinkCandidate } from './uplink-pool';

export function redactUrl(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    const stripped = raw
      .replace(/[?#].*$/, '')
      .replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#]*@/, '$1');
    try {
      return new URL(stripped).origin;
    } catch {
      return stripped.replace(/\/+$/, '') || raw;
    }
  }
}

export function normalizeHubEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return canonicalHubUrl(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function sameHubUrl(a: string, b: string): boolean {
  return normalizeHubEndpointUrl(a) === normalizeHubEndpointUrl(b);
}

export function isSelfHubCandidate(
  cand: Pick<UplinkCandidate, 'hubNodeId' | 'publicUrl'>,
  self: { nodeId?: string | null; publicUrl?: string | null }
): boolean {
  if (self.nodeId && cand.hubNodeId && cand.hubNodeId === self.nodeId) return true;
  if (self.publicUrl && sameHubUrl(cand.publicUrl, self.publicUrl)) return true;
  return false;
}

export function attachedHubHost(
  attached: AttachedHub | null,
  fallbackUrl?: string | null
): string | null {
  const url = attached?.publicUrl ?? fallbackUrl;
  if (!url) return null;
  try {
    return hubHostFromUrl(url);
  } catch {
    return null;
  }
}
