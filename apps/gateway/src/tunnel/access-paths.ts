/**
 * Origin JWT 守卫豁免与 Cloudflare Access bypass 应用的机器路径。
 *
 * Hub HTTP（`hub-runtime.handleRequest`）：
 * - `/hub/uplink` — 节点常驻 WS（无浏览器 Access cookie）
 * - `/api/hub/enrollments/redeem` — CLI redeem（无用户 session）
 * - `/api/hub/enrollments` POST / GET `:id`、`/api/hub/nodes` 及 rename/revoke — 带 VibeTerm 用户鉴权；
 *   与 redeem 同属 `/api/hub/`，bypass 应用按此前缀覆盖，避免 CLI 被边缘拦截
 *
 * Relay HTTP（`relay-runtime.handleRequest`），与 hub 同理的机器路径：
 * - `/relay/uplink` — 租户节点常驻 WS
 * - `/api/relay/health` — 匿名健康检查（节点拨号前探测）
 * - `/api/relay/enroll` — 根签名 proof + 中继口令，无浏览器会话
 * - `/api/relay/tenants/:id/enrollments/*` — redeem 与 authorization 查询，凭租户令牌
 *   管理面 `/api/relay/status|password|config|tenants/:id` **不豁免**：它们本就该走浏览器/管理令牌。
 *
 * 网关：
 * - `/healthz` — 匿名健康检查；仅 origin 守卫豁免（边缘 Access 拦截由 check job 识别为 access_protected）
 */
export const ACCESS_EXEMPT_EXACT_PATHS = [
  '/healthz',
  '/relay/uplink',
  '/api/relay/health',
  '/api/relay/enroll',
] as const;

/** 只做 origin 守卫豁免、不建 Cloudflare bypass app 的前缀。 */
export const ACCESS_EXEMPT_PATH_PREFIXES = ['/api/relay/tenants/'] as const;

/** Cloudflare path app 的 domain 后缀（更具体路径优先） */
export const ACCESS_BYPASS_PATH_PREFIXES = ['/hub/', '/api/hub/'] as const;

// 新建 Cloudflare Access 资源用的名字。改名前建的资源仍叫 tmex*，读侧一律双接受：
// 认成「我们管理的」才能就地改写，否则会被当成用户手工加的策略而拒绝同步。
export const VIBETERM_ALLOW_POLICY_NAME = 'vibeterm-allow';
export const VIBETERM_BYPASS_POLICY_NAME = 'vibeterm-bypass';
export const VIBETERM_APP_NAME = 'VibeTerm';
const VIBETERM_BYPASS_APP_PREFIX = 'vibeterm-bypass';

const LEGACY_ALLOW_POLICY_NAME = 'tmex-allow';
const LEGACY_BYPASS_POLICY_NAME = 'tmex-bypass';
const LEGACY_APP_NAME = 'tmex';
const LEGACY_BYPASS_APP_PREFIX = 'tmex-bypass';

export function bypassAppName(pathPrefix: string): string {
  const slug = pathPrefix.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'hub';
  return `${VIBETERM_BYPASS_APP_PREFIX}-${slug}`;
}

/** 是我们管理的 allow 策略名（含改名前的旧名） */
export function isManagedAllowPolicyName(name: string): boolean {
  return name === VIBETERM_ALLOW_POLICY_NAME || name === LEGACY_ALLOW_POLICY_NAME;
}

/** 是我们管理的 bypass 策略名（含改名前的旧名） */
export function isManagedBypassPolicyName(name: string): boolean {
  return name === VIBETERM_BYPASS_POLICY_NAME || name === LEGACY_BYPASS_POLICY_NAME;
}

/** 是我们管理的 Access 应用名（含改名前的旧名） */
export function isManagedAppName(name: string): boolean {
  return name === VIBETERM_APP_NAME || name === LEGACY_APP_NAME;
}

/** 是我们管理的 bypass 应用名（按前缀，含改名前的旧前缀） */
export function isManagedBypassAppName(name: string): boolean {
  return (
    name.startsWith(`${VIBETERM_BYPASS_APP_PREFIX}-`) ||
    name.startsWith(`${LEGACY_BYPASS_APP_PREFIX}-`)
  );
}

export function bypassAppDomain(hostname: string, pathPrefix: string): string {
  return `${hostname}${pathPrefix}`;
}

export function isAccessGuardExemptPath(pathname: string): boolean {
  if ((ACCESS_EXEMPT_EXACT_PATHS as readonly string[]).includes(pathname)) return true;
  for (const prefix of ACCESS_EXEMPT_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  for (const prefix of ACCESS_BYPASS_PATH_PREFIXES) {
    if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) return true;
  }
  return false;
}
