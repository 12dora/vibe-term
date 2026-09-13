// 本机登录门（standalone bootstrap / 开关）与账号安全只读端点的 REST 封装。
// 改密 / TOTP / 删 passkey 走 key-log 签名，不在这里组包。

import type { BootstrapLocalAuthRequest, LocalAuthStatus } from '@vibeterm/shared';
import { type ApiClient, defaultApiClient } from '../client';
import { JSON_HEADERS } from '../json-mutation';
import { LocalAuthApiError, type LocalAuthMutationResponse } from './types';

async function readErrorCode(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { code?: unknown };
    if (typeof payload.code === 'string' && payload.code) return payload.code;
  } catch {
    // 落到 HTTP 状态兜底
  }
  return `HTTP_${res.status}`;
}

async function postLocalAuth(
  path: string,
  body: unknown,
  client: ApiClient
): Promise<LocalAuthStatus> {
  const res = await client.fetch(path, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new LocalAuthApiError(await readErrorCode(res), res.status);
  const payload = (await res.json()) as Partial<LocalAuthMutationResponse>;
  if (!payload.localAuth) throw new LocalAuthApiError('MALFORMED', res.status);
  return payload.localAuth;
}

/** `POST /api/auth/local/bootstrap`：门未生效时创建第一位可登录用户。 */
export function bootstrapLocalAuth(
  req: BootstrapLocalAuthRequest,
  client: ApiClient = defaultApiClient
): Promise<LocalAuthStatus> {
  return postLocalAuth('/api/auth/local/bootstrap', req, client);
}

/** `POST /api/auth/local`：开 / 关本机登录。无凭证时置 true 会被 409 挡下。 */
export function setLocalAuthEnabled(
  enabled: boolean,
  client: ApiClient = defaultApiClient
): Promise<LocalAuthStatus> {
  return postLocalAuth('/api/auth/local', { enabled }, client);
}

export function localAuthErrorCode(error: unknown): string {
  return error instanceof LocalAuthApiError ? error.code : 'unknown';
}
