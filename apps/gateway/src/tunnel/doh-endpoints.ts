/**
 * DoH JSON 端点一律用 IP 字面量：系统解析器坏掉时（如 VPN 残留的分流 DNS）域名形式的端点自己就解析不出来；
 * 境内可达的阿里 / DNSPod 在前，Cloudflare / Google 兜底。`VIBETERM_DOH_ENDPOINTS`（逗号分隔）整体覆盖。
 */
export const DOH_ENDPOINTS = [
  'https://223.5.5.5/resolve',
  'https://120.53.53.53/dns-query',
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/resolve',
] as const;
export const DOH_ENDPOINTS_ENV = 'VIBETERM_DOH_ENDPOINTS';

export function dohEndpoints(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[DOH_ENDPOINTS_ENV]?.trim();
  if (!raw) return [...DOH_ENDPOINTS];
  const list = raw
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item) => /^https:\/\//.test(item));
  return list.length > 0 ? list : [...DOH_ENDPOINTS];
}
