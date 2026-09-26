import type { LoginPolicyStatus } from '@vibeterm/shared/auth';
import { type ApiClient, toApiError } from '../client';
import { requestJson } from '../json-mutation';

export const LOGIN_POLICY_PATH = '/api/auth/login-policy';

export function getLoginPolicy(
  client: ApiClient,
  signal?: AbortSignal
): Promise<LoginPolicyStatus> {
  return requestJson<LoginPolicyStatus>(client, LOGIN_POLICY_PATH, {
    signal,
    toError: (res) => toApiError(res, 'Failed to load login policy'),
  });
}
