import type {
  AssistRegexRequest,
  AssistRegexResponse,
  CreateWatchRuleRequest,
  ListWatchRulesResponse,
  UpdateWatchRuleRequest,
  WatchRuleDto,
  WatchRuleResponse,
  WatchRuleStateResponse,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export const watchRulesQueryKey = (deviceId: string, paneId: string) =>
  ['watch-rules', deviceId, paneId] as const;

export const watchRuleStateQueryKey = (ruleId: string) => ['watch-rule-state', ruleId] as const;

export async function fetchWatchRules(
  deviceId: string,
  paneId: string,
  client: ApiClient = defaultApiClient
): Promise<WatchRuleDto[]> {
  const params = new URLSearchParams({ deviceId, paneId });
  return requestJson<ListWatchRulesResponse, WatchRuleDto[]>(client, `/api/watch/rules?${params}`, {
    errorFallback: 'Failed to load watch rules',
    pick: (payload) => payload.rules,
  });
}

export async function createWatchRule(
  body: CreateWatchRuleRequest,
  client: ApiClient = defaultApiClient
): Promise<WatchRuleResponse> {
  return requestJson<WatchRuleResponse>(client, '/api/watch/rules', {
    method: 'POST',
    body,
    errorFallback: 'Failed to create watch rule',
  });
}

export async function updateWatchRule(
  ruleId: string,
  body: UpdateWatchRuleRequest,
  client: ApiClient = defaultApiClient
): Promise<WatchRuleResponse> {
  return requestJson<WatchRuleResponse>(client, `/api/watch/rules/${ruleId}`, {
    method: 'PATCH',
    body,
    errorFallback: 'Failed to update watch rule',
  });
}

export async function deleteWatchRule(
  ruleId: string,
  client: ApiClient = defaultApiClient
): Promise<void> {
  await requestOk(client, `/api/watch/rules/${ruleId}`, {
    method: 'DELETE',
    errorFallback: 'Failed to delete watch rule',
  });
}

/** 非 2xx 返回 null（调用方按缓存缺失处理）；网络异常仍抛出 */
export async function fetchWatchRule(
  ruleId: string,
  client: ApiClient = defaultApiClient
): Promise<WatchRuleDto | null> {
  const res = await client.fetch(`/api/watch/rules/${ruleId}`);
  if (!res.ok) {
    return null;
  }
  const payload = (await res.json()) as { rule?: WatchRuleDto };
  return payload.rule ?? null;
}

export async function fetchWatchRuleState(
  ruleId: string,
  client: ApiClient = defaultApiClient
): Promise<WatchRuleStateResponse> {
  return requestJson<WatchRuleStateResponse>(client, `/api/watch/rules/${ruleId}/state`, {
    errorFallback: 'Failed to load watch rule state',
  });
}

export async function assistRegex(
  body: AssistRegexRequest,
  client: ApiClient = defaultApiClient
): Promise<AssistRegexResponse> {
  return requestJson<AssistRegexResponse>(client, '/api/watch/assist-regex', {
    method: 'POST',
    body,
    errorFallback: 'Failed to generate regex',
  });
}

export { parseApiError } from './client';
