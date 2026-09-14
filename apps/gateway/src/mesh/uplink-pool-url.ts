import { canonicalPublicUrl, hostFromUrl } from '@vibeterm/shared/auth';
import type { AttachedUplink } from './uplink-pool';

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

export function normalizeUplinkEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    return canonicalPublicUrl(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function sameUplinkUrl(a: string, b: string): boolean {
  return normalizeUplinkEndpointUrl(a) === normalizeUplinkEndpointUrl(b);
}

export function attachedUplinkHost(
  attached: AttachedUplink | null,
  fallbackUrl?: string | null
): string | null {
  const url = attached?.publicUrl ?? fallbackUrl;
  if (!url) return null;
  try {
    return hostFromUrl(url);
  } catch {
    return null;
  }
}
