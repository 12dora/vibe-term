// standalone 本机登录开关的两个动作：创建第一位用户（bootstrap）与开关本身。
//
// 两个接口都只允许从本机访问（远程调用返回 403 `LOCAL_ONLY`），响应体统一带回最新的
// `localAuth` 状态——调用方直接用它覆盖本地快照，不必再拉一次 `/api/auth/mode`。

import { type ApiClient, defaultApiClient } from '@tmex/api-client';
import { LocalAuthApiError, type LocalAuthMutationResponse } from '@tmex/api-client/auth/index';
import type { BootstrapLocalAuthRequest, LocalAuthStatus } from '@tmex/shared';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

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

/** 未知异常也要给出一个可映射的 code，不能让 UI 落到空文案。 */
export function localAuthErrorCode(error: unknown): string {
  return error instanceof LocalAuthApiError ? error.code : 'unknown';
}
