import { isVibeTermHeaderName } from '../../../packages/shared/src/http/mesh-headers.ts';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function collectVibeTermHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // 新旧头名是兼容桥，快照保留双发的两组头。
    if (isVibeTermHeaderName(lower) || lower === 'content-type' || lower === 'content-length') {
      out[lower] = value;
    }
  });
  return out;
}
