// 访问令牌的展示文案与创建表单解析（纯函数，单测直接覆盖）。

import { formatRelative } from '@/lib/format-relative';
import { isApiErrorCode } from '@vibeterm/api-client';
import {
  ACCESS_TOKEN_ACTIVE_LIMIT,
  ACCESS_TOKEN_NAME_MAX,
  ACCESS_TOKEN_SCOPES,
  type AccessTokenDto,
  type AccessTokenScope,
  type CreateAccessTokenRequest,
  errorMessage,
} from '@vibeterm/shared';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const TOKENS_NS = 'auth.security.tokens';
export const TOKEN_NAME_MAX = ACCESS_TOKEN_NAME_MAX;

export const TOKEN_EXPIRY_OPTIONS = ['30', '90', '365', 'never'] as const;
export type TokenExpiryOption = (typeof TOKEN_EXPIRY_OPTIONS)[number];

/** 各权限对应的 CLI 子命令：命令名不翻译。 */
export const TOKEN_SCOPE_COMMANDS: Record<AccessTokenScope, string> = {
  exec: 'exec · rsh',
  files: 'cp',
  forward: 'forward',
};

export interface TokenDraft {
  name: string;
  scopes: AccessTokenScope[];
  expiry: TokenExpiryOption;
}

export function emptyTokenDraft(): TokenDraft {
  return { name: '', scopes: ['exec'], expiry: '90' };
}

export type TokenDraftErrors = { name?: string; scopes?: string };

export type ParsedTokenDraft =
  | { ok: true; body: CreateAccessTokenRequest }
  | { ok: false; errors: TokenDraftErrors };

export function parseTokenDraft(t: Translate, draft: TokenDraft): ParsedTokenDraft {
  const name = draft.name.trim();
  const errors: TokenDraftErrors = {};
  if (!name) {
    errors.name = t(`${TOKENS_NS}.form.nameRequired`);
  } else if (name.length > TOKEN_NAME_MAX) {
    errors.name = t(`${TOKENS_NS}.form.nameTooLong`, { max: TOKEN_NAME_MAX });
  }
  const scopes = ACCESS_TOKEN_SCOPES.filter((scope) => draft.scopes.includes(scope));
  if (scopes.length === 0) errors.scopes = t(`${TOKENS_NS}.form.scopeRequired`);
  if (errors.name || errors.scopes) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      scopes,
      expiresInDays: draft.expiry === 'never' ? null : Number(draft.expiry),
    },
  };
}

export function toggleScope(
  scopes: readonly AccessTokenScope[],
  scope: AccessTokenScope,
  checked: boolean
): AccessTokenScope[] {
  const next = new Set(scopes);
  if (checked) next.add(scope);
  else next.delete(scope);
  return ACCESS_TOKEN_SCOPES.filter((item) => next.has(item));
}

export function scopeText(t: Translate, scope: AccessTokenScope): string {
  return t(`${TOKENS_NS}.scope.${scope}`);
}

export function expiryOptionText(t: Translate, option: TokenExpiryOption): string {
  return t(`${TOKENS_NS}.expiry.${option === 'never' ? 'never' : `d${option}`}`);
}

export function createdText(t: Translate, token: Pick<AccessTokenDto, 'createdAt'>): string {
  return t(`${TOKENS_NS}.createdAt`, { date: new Date(token.createdAt).toLocaleDateString() });
}

export function lastUsedText(
  t: Translate,
  token: Pick<AccessTokenDto, 'lastUsedAt'>,
  now: number
): string {
  const relative = formatRelative(t, token.lastUsedAt, now, 'settings.share.time');
  return relative ? t(`${TOKENS_NS}.lastUsed`, { time: relative }) : t(`${TOKENS_NS}.neverUsed`);
}

/** 悬停详情：绝对时间 + 来源 IP；从未使用时没有可补充的。 */
export function lastUsedTitle(token: Pick<AccessTokenDto, 'lastUsedAt' | 'lastUsedIp'>): string {
  if (token.lastUsedAt == null) return '';
  const at = new Date(token.lastUsedAt).toLocaleString();
  return token.lastUsedIp ? `${at} · ${token.lastUsedIp}` : at;
}

export function isTokenExpired(token: Pick<AccessTokenDto, 'expiresAt'>, now: number): boolean {
  return token.expiresAt != null && token.expiresAt <= now;
}

export function expiresText(
  t: Translate,
  token: Pick<AccessTokenDto, 'expiresAt'>,
  now: number
): string {
  if (token.expiresAt == null) return t(`${TOKENS_NS}.neverExpires`);
  if (isTokenExpired(token, now)) return t(`${TOKENS_NS}.expired`);
  return t(`${TOKENS_NS}.expiresAt`, { date: new Date(token.expiresAt).toLocaleDateString() });
}

export function tokenErrorText(t: Translate, err: unknown): string {
  if (isApiErrorCode(err, 'token_limit')) {
    return t(`${TOKENS_NS}.errors.limit`, { max: ACCESS_TOKEN_ACTIVE_LIMIT });
  }
  return errorMessage(err);
}
