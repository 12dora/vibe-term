// HTTPS 配置表单的纯逻辑：SAN / 端口 / 域名 / 邮箱校验、ACME 轮询节奏与时间展示。
//
// 规则与批次 2 契约（PUT /api/tls）逐条对齐，前端先拦一遍只是为了少一次往返，后端仍是权威。

import type { TlsStatusResponse } from '@tmex/api-client/local/tls-types';

export const ACME_POLL_INTERVAL_MS = 3000;

/** ACME 签发是后台任务，只有 pending 期间才轮询 `GET /api/tls`。 */
export function acmePollInterval(status: TlsStatusResponse | null | undefined): number | false {
  return status?.acme?.status === 'pending' ? ACME_POLL_INTERVAL_MS : false;
}

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP_PATTERN = /^[0-9A-Fa-f]{1,4}$/;
const IPV6_GROUP_COUNT = 8;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export const MAX_SANS = 20;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

const VALIDATION_PREFIX = 'nodes.https.validation.';

export function isIpv4Address(value: string): boolean {
  const match = IPV4_PATTERN.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

/**
 * 严格 IPv6：最多一个 `::`，每组 1-4 位十六进制，允许结尾内嵌一个 IPv4（占两组）。
 * 未压缩时必须正好 8 组，压缩时不超过 7 组（`::` 至少代表一组零）。
 *
 * 粗校验（只看字符集）会放过 `::::` 与 `1:2:3:4:5:6:7:8:9`，签发时后端才以 `invalid_sans` 拒掉。
 */
export function isIpv6Address(value: string): boolean {
  if (!value.includes(':')) return false;
  const sides = value.split('::');
  if (sides.length > 2) return false;
  const compressed = sides.length === 2;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = compressed && sides[1] ? sides[1].split(':') : [];
  const groups = [...head, ...tail];
  if (groups.some((group) => group === '')) return false;

  let count = groups.length;
  const last = groups[count - 1];
  if (last?.includes('.')) {
    if (!isIpv4Address(last)) return false;
    groups.pop();
    count += 1;
  }
  if (groups.some((group) => !IPV6_GROUP_PATTERN.test(group))) return false;
  return compressed ? count < IPV6_GROUP_COUNT : count === IPV6_GROUP_COUNT;
}

export function isIpAddress(value: string): boolean {
  return isIpv4Address(value) || isIpv6Address(value);
}

/**
 * SAN 条目：合法主机名或 IP（IPv6 允许带方括号书写）。
 *
 * 末段全数字的名字（`999.1.1.1`）既不是合法 IPv4 也不是合法主机名（RFC 1123 要求顶级标签
 * 不能全为数字），必须挡掉——否则会签出一张永远匹配不上的证书。
 */
export function isValidSan(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const bare = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (isIpAddress(bare)) return true;
  if (!HOSTNAME_PATTERN.test(bare)) return false;
  const lastLabel = bare.split('.').pop() ?? '';
  return !/^\d+$/.test(lastLabel);
}

/** 粘贴友好：逗号、分号、空白、换行都算分隔符，顺带去重。 */
export function parseSansInput(raw: string): string[] {
  const parts = raw
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

/** 返回 i18n key；通过校验返回 null。 */
export function validateSans(sans: string[]): string | null {
  if (sans.length === 0) return `${VALIDATION_PREFIX}sansRequired`;
  if (sans.length > MAX_SANS) return `${VALIDATION_PREFIX}sansTooMany`;
  return sans.every(isValidSan) ? null : `${VALIDATION_PREFIX}sansInvalid`;
}

export function validatePort(raw: string): string | null {
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return `${VALIDATION_PREFIX}portInvalid`;
  }
  return null;
}

export function validateBindHost(raw: string): string | null {
  return raw.trim() ? null : `${VALIDATION_PREFIX}hostRequired`;
}

/** ACME v1 不支持通配符，域名必须是可解析的主机名。 */
export function validateDomain(raw: string): string | null {
  const domain = raw.trim();
  if (!domain || domain.includes('*') || !HOSTNAME_PATTERN.test(domain) || !domain.includes('.')) {
    return `${VALIDATION_PREFIX}domainInvalid`;
  }
  return null;
}

export function validateEmail(raw: string): string | null {
  return EMAIL_PATTERN.test(raw.trim()) ? null : `${VALIDATION_PREFIX}emailInvalid`;
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/** 地址栏主机名只在不是本机回环时才值得预填进 SAN 列表。 */
export function defaultSans(hostname: string | null): string[] {
  if (!hostname || isLocalHostname(hostname) || !isValidSan(hostname)) return [];
  return [hostname];
}

const MS_PER_DAY = 86_400_000;

/** 距 `notAfter` 还有几天；已过期返回负数。 */
export function daysUntil(timestamp: number, now: number = Date.now()): number {
  return Math.floor((timestamp - now) / MS_PER_DAY);
}

export function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}
