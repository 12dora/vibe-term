// 一次性登录命令的节点接口（签发 / 查询 / 作废）。由 `AuthApi` 薄封装后对外暴露。

import {
  LOGIN_CODE_PATH,
  LOGIN_CODE_REVOKE_PATH,
  LOGIN_CODE_STATUS_PATH,
  type LoginCodeIssueRequest,
  type LoginCodeIssueResponse,
  type LoginCodeStatusResponse,
} from '@vibeterm/shared';
import type { ApiClient } from '../client';
import { resolveNodeUrl } from '../node-url';

export type { LoginCodeIssueRequest };
export type LoginCodeStatusResult = LoginCodeStatusResponse | null;

export type LoginCodeIssueResult =
  | { ok: true; expiresAt: number }
  | { ok: false; status: number; code: string; retryAfterMs?: number };

interface FailureBody {
  code?: unknown;
  error?: unknown;
  retryAfterMs?: unknown;
}

async function failureOf(
  res: Response,
  fallback: string
): Promise<{ code: string; retryAfterMs?: number }> {
  const body = (await res.json().catch(() => null)) as FailureBody | null;
  const code =
    [body?.code, body?.error].find((value): value is string => typeof value === 'string') ??
    fallback;
  const wait = body?.retryAfterMs;
  return typeof wait === 'number' && Number.isFinite(wait) && wait > 0
    ? { code, retryAfterMs: wait }
    : { code };
}

function post(
  client: ApiClient,
  headers: Record<string, string>,
  nodeId: string,
  path: string,
  body: unknown
): Promise<Response> {
  return client.fetch(resolveNodeUrl(nodeId, path), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** `POST /api/auth/login-code`：4xx 不抛异常，网络错误照常抛。 */
export async function requestIssueLoginCode(
  client: ApiClient,
  headers: Record<string, string>,
  nodeId: string,
  body: LoginCodeIssueRequest
): Promise<LoginCodeIssueResult> {
  const res = await post(client, headers, nodeId, LOGIN_CODE_PATH, body);
  if (!res.ok) {
    const fallback = res.status === 429 ? 'RATE_LIMITED' : `HTTP_${res.status}`;
    return { ok: false, status: res.status, ...(await failureOf(res, fallback)) };
  }
  const payload = (await res.json()) as LoginCodeIssueResponse;
  return { ok: true, expiresAt: payload.expires_at };
}

/** `status` / `revoke`：404（码不存在或旧节点没有该接口）为 null，其余失败抛带 `code` 的错误。 */
export async function requestLoginCodeLookup(
  client: ApiClient,
  headers: Record<string, string>,
  nodeId: string,
  action: 'status' | 'revoke',
  code: string
): Promise<LoginCodeStatusResult> {
  const path = action === 'status' ? LOGIN_CODE_STATUS_PATH : LOGIN_CODE_REVOKE_PATH;
  const res = await post(client, headers, nodeId, path, { code });
  if (res.status === 404) return null;
  if (!res.ok) {
    const failure = await failureOf(res, `HTTP_${res.status}`);
    throw Object.assign(new Error(`login code ${action} failed: ${failure.code}`), {
      ...failure,
      status: res.status,
    });
  }
  return (await res.json()) as LoginCodeStatusResponse;
}
