// Cloudflare Access 区块的纯推导：规则草稿的校验与归一、可用性判断、步骤标签。

import type {
  LocalAuthStatus,
  TunnelAccessMode,
  TunnelAccessPolicyRule,
  TunnelActionRequest,
  TunnelStatusResponse,
} from '@tmex/shared';
import { directProtected } from './direct-model';
import type { StepState } from './tunnel-model';

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
 * `configure_access` 的目标主机名：已建隧道用服务端保存的那个，还没建时用向导里刚确认的草稿
 * （契约允许显式传 `hostname`，先于建隧道把 Access 配好）。
 * `access.hostname` 只代表已有应用**当前覆盖**的地址，不参与目标推导——隧道被移除后它仍会留着。
 */
export function accessConfigureHostname(
  status: TunnelStatusResponse,
  draftHostname: string
): string | null {
  const draft = draftHostname.trim();
  return status.config.hostname ?? (draft.length > 0 ? draft : null);
}

/** `sync_access` 的目标：与后端一致，`config.hostname ?? external.hostnames[0]`。 */
export function accessSyncHostname(status: TunnelStatusResponse): string | null {
  return status.config.hostname ?? status.external.hostnames[0] ?? null;
}

export function canApplyAccess(
  status: TunnelStatusResponse,
  drafts: AccessRuleDraft[],
  draftHostname: string
): boolean {
  return (
    status.access.hasCredentials &&
    accessConfigureHostname(status, draftHostname) !== null &&
    accessRulesValid(drafts)
  );
}

export function canSyncAccess(status: TunnelStatusResponse): boolean {
  return status.access.hasCredentials && accessSyncHostname(status) !== null;
}

/** 隧道还没建时显式带上向导确认的主机名；已建则不带，由服务端用 `config.hostname`。 */
export function configureAccessRequest(
  status: TunnelStatusResponse,
  rules: TunnelAccessPolicyRule[],
  draftHostname: string
): TunnelActionRequest {
  const hostname = accessConfigureHostname(status, draftHostname);
  return status.config.mode === 'off' && hostname
    ? { action: 'configure_access', rules, hostname }
    : { action: 'configure_access', rules };
}

/** 凭证已保存但本地还没有应用：先让用户从 Cloudflare 同步，避免重复建应用。 */
export function shouldOfferAccessSync(status: TunnelStatusResponse): boolean {
  return status.access.hasCredentials && !status.access.configured && canSyncAccess(status);
}

export type AccessStepTag = 'recommended' | 'optional';

/**
 * 用户明确选过、或本机当前真有保护（Access 已生效 / 登录门在）时只是加固，标「可选」；
 * 其余情况都是「还没有任何保护」——包括旧数据里留着一个没生效的 Access 应用——标「推荐」。
 */
export function accessStepTag(status: TunnelStatusResponse): AccessStepTag {
  if (status.config.accessMode !== null) return 'optional';
  return accessEffective(status) || status.loginEnforced ? 'optional' : 'recommended';
}

/**
 * Access 校验是否真的生效。后端 `access.effective` 是唯一真相；旧后端没有这个字段时
 * 用同一条谓词兜底：应用已建、网关强制校验，且应用覆盖的主机名就是当前隧道的主机名
 * （两边都为空不算匹配——没有隧道就谈不上保护）。
 */
export function accessEffective(status: TunnelStatusResponse): boolean {
  const access: { effective?: boolean } = status.access;
  return (
    access.effective ??
    Boolean(
      status.access.configured &&
        status.access.enforceJwt &&
        status.access.hostname &&
        status.access.hostname === status.config.hostname
    )
  );
}

/**
 * 当前生效的访问保护方式。用户选过就以选择为准；`null`（旧数据 / 从没选过）按实际保护推导：
 * 先看真正在生效的那一个（Access 校验 > 登录门），都没有时再看有没有一个没生效的 Access 应用
 * ——那说明用户走的是 Access 这条路，只是还没配好，展开这一档正好告诉他怎么修。
 */
export function effectiveAccessMode(status: TunnelStatusResponse): TunnelAccessMode | null {
  if (status.config.accessMode !== null) return status.config.accessMode;
  if (accessEffective(status)) return 'cloudflare';
  if (status.loginEnforced) return 'login';
  return status.access.configured ? 'cloudflare' : null;
}

/**
 * 选定访问保护方式的动作。选「无」时是否带 `acknowledgeExposure` 由发起动作的那条警示决定
 * （见 `exposureAck`），这里只负责组请求体。
 */
export function setAccessModeRequest(accessMode: TunnelAccessMode): TunnelActionRequest {
  return { action: 'set_access_mode', accessMode };
}

/** 访问控制步的完成度：选定的方式真正落地了才打勾，没选过则停在当前步。 */
export function accessStepState(
  status: TunnelStatusResponse,
  localAuth?: LocalAuthStatus | null
): StepState {
  switch (effectiveAccessMode(status)) {
    case 'none':
      return 'done';
    case 'login':
      return status.loginEnforced || directProtected(localAuth) ? 'done' : 'current';
    case 'cloudflare':
      return accessEffective(status) ? 'done' : 'current';
    default:
      return 'current';
  }
}

/**
 * 外部只读探测的三态：`unknown` 是「查不了」（没有可用凭证或 Cloudflare API 失败），
 * 与「查过了，没有」是两回事，不能都显示成未配置。
 * 探测结果只描述 Cloudflare 控制台上的现状，与 `access.configured`（tmex 托管、网关校验 JWT）无关。
 */
export type ExternalAccessState = 'unknown' | 'covered' | 'absent';

export function externalAccessState(status: TunnelStatusResponse): ExternalAccessState {
  const probe = status.external.externalAccess;
  if (!probe?.checked) return 'unknown';
  return probe.hostnameMatch ? 'covered' : 'absent';
}
