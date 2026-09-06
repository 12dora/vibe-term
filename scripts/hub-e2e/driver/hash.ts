export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function collectVibeTermHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // 协议常量，沿用 tmex 时期的值以保持跨版本兼容
    if (lower.startsWith('x-tmex-') || lower === 'content-type' || lower === 'content-length') {
      out[lower] = value;
    }
  });
  return out;
}
