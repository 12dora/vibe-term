// Cloudflare Access 区块的纯推导：规则草稿的校验与归一、可用性判断、步骤标签。

import type { TunnelAccessPolicyRule, TunnelStatusResponse } from '@tmex/shared';

export type AccessRuleKind = TunnelAccessPolicyRule['kind'];

export interface AccessRuleDraft {
  /** 列表渲染用的稳定键，与后端无关。 */
  key: string;
  kind: AccessRuleKind;
  value: string;
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const DOMAIN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function isValidRuleValue(kind: AccessRuleKind, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  return kind === 'email' ? EMAIL.test(trimmed) : DOMAIN.test(trimmed);
}

export type AccessRuleError = 'empty' | 'invalid';

export function ruleDraftError(draft: AccessRuleDraft): AccessRuleError | null {
  if (draft.value.trim().length === 0) return 'empty';
  return isValidRuleValue(draft.kind, draft.value) ? null : 'invalid';
}

/** 至少一条规则，且每一条都合法——空策略等于谁都进不来，Cloudflare 也会拒绝。 */
export function accessRulesValid(drafts: AccessRuleDraft[]): boolean {
  return drafts.length > 0 && drafts.every((draft) => ruleDraftError(draft) === null);
}

/** 提交前归一：去空白并统一小写（Cloudflare 侧邮箱与域名都不区分大小写）。 */
export function toAccessRules(drafts: AccessRuleDraft[]): TunnelAccessPolicyRule[] {
  return drafts.map((draft) => ({ kind: draft.kind, value: draft.value.trim().toLowerCase() }));
}

export function ruleDraftsFrom(rules: TunnelAccessPolicyRule[]): AccessRuleDraft[] {
  return rules.map((rule, index) => ({
    key: `saved-${index}`,
    kind: rule.kind,
    value: rule.value,
  }));
}

/**
 * Access 应用绑在主机名上：`configure_access` / `sync_access` 都不带主机名参数，
 * 服务端用的是已保存的那个，所以没有主机名之前这两个动作都无从谈起。
 */
export function accessTargetHostname(status: TunnelStatusResponse): string | null {
  return status.access.hostname ?? status.config.hostname;
}

export function canApplyAccess(status: TunnelStatusResponse, drafts: AccessRuleDraft[]): boolean {
  return (
    status.access.hasCredentials &&
    accessTargetHostname(status) !== null &&
    accessRulesValid(drafts)
  );
}

/**
 * 同步比应用宽松一档：后端在没有隧道主机名时会退回探测到的系统隧道主机名，
 * 所以只要有一个可匹配的主机名就允许同步。
 */
export function canSyncAccess(status: TunnelStatusResponse): boolean {
  return (
    status.access.hasCredentials &&
    (accessTargetHostname(status) !== null || status.external.hostnames.length > 0)
  );
}

/** 凭证已保存但本地还没有应用：先让用户从 Cloudflare 同步，避免重复建应用。 */
export function shouldOfferAccessSync(status: TunnelStatusResponse): boolean {
  return status.access.hasCredentials && !status.access.configured && canSyncAccess(status);
}

export type AccessStepTag = 'recommended' | 'optional';

/** 没有登录体系时 Access 是唯一的鉴权层，标「推荐」；有登录时只是加固，标「可选」。 */
export function accessStepTag(status: TunnelStatusResponse): AccessStepTag {
  return status.loginEnforced ? 'optional' : 'recommended';
}
