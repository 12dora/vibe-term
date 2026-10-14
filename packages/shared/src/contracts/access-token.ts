// 机器访问令牌（每节点本地表）的 HTTP 契约。网关、前端和 CLI 共用。

export const ACCESS_TOKEN_SCOPES = ['exec', 'files', 'forward'] as const;
export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number];

export const ACCESS_TOKEN_SECRET_PREFIX = 'vtk_';
export const ACCESS_TOKEN_NAME_MAX = 64;
export const ACCESS_TOKEN_EXPIRES_DAYS_MAX = 3650;
/** 每个用户同时有效（未撤销且未过期）的令牌上限。 */
export const ACCESS_TOKEN_ACTIVE_LIMIT = 50;

export type AccessTokenDto = {
  id: string;
  name: string;
  scopes: AccessTokenScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
};

export type CreateAccessTokenRequest = {
  name: string;
  scopes: AccessTokenScope[];
  expiresInDays: number | null;
};

/** 明文令牌只在创建响应里出现一次。 */
export type CreateAccessTokenResponse = { token: AccessTokenDto; secret: string };

export type AccessTokenListResponse = { tokens: AccessTokenDto[] };

export function isAccessTokenScope(value: unknown): value is AccessTokenScope {
  return (ACCESS_TOKEN_SCOPES as readonly unknown[]).includes(value);
}
