// 访问令牌 REST（仅会话鉴权可调，令牌本身调不了）。传入节点 ApiClient 即管理该节点的令牌。

import type {
  AccessTokenListResponse,
  CreateAccessTokenRequest,
  CreateAccessTokenResponse,
} from '@vibeterm/shared';
import { type ApiClient, toApiError } from '../client';
import { requestJson, requestOk } from '../json-mutation';

export const ACCESS_TOKENS_PATH = '/api/auth/tokens';

function accessTokensError(fallback: string) {
  return (res: Response) => toApiError(res, fallback);
}

export function listAccessTokens(
  client: ApiClient,
  signal?: AbortSignal
): Promise<AccessTokenListResponse> {
  return requestJson<AccessTokenListResponse>(client, ACCESS_TOKENS_PATH, {
    signal,
    toError: accessTokensError('Failed to load access tokens'),
  });
}

export function createAccessToken(
  client: ApiClient,
  body: CreateAccessTokenRequest
): Promise<CreateAccessTokenResponse> {
  return requestJson<CreateAccessTokenResponse>(client, ACCESS_TOKENS_PATH, {
    method: 'POST',
    body,
    toError: accessTokensError('Failed to create access token'),
  });
}

export async function revokeAccessToken(client: ApiClient, id: string): Promise<void> {
  await requestOk(client, `${ACCESS_TOKENS_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    toError: accessTokensError('Failed to revoke access token'),
  });
}
