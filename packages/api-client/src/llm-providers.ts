// LLM providers / Agent LLM 设置 REST 端点

import type {
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  GetAgentLlmSettingsResponse,
  ListLlmProvidersResponse,
  UpdateLlmProviderRequest,
  UpdateLlmProviderResponse,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient } from './client';
import { requestJson } from './json-mutation';

export const llmProvidersQueryKey = ['llm-providers'] as const;
export const llmSettingsQueryKey = ['llm-settings'] as const;

export async function fetchLlmProviders(
  errorFallback = 'Failed to load providers',
  client: ApiClient = defaultApiClient
): Promise<ListLlmProvidersResponse> {
  return requestJson<ListLlmProvidersResponse>(client, '/api/llm/providers', { errorFallback });
}

export async function fetchAgentLlmSettings(
  errorFallback = 'Failed to load LLM settings',
  client: ApiClient = defaultApiClient
): Promise<GetAgentLlmSettingsResponse> {
  return requestJson<GetAgentLlmSettingsResponse>(client, '/api/llm/settings', { errorFallback });
}

export async function createLlmProvider(
  body: CreateLlmProviderRequest,
  errorFallback = 'Failed to create provider',
  client: ApiClient = defaultApiClient
): Promise<CreateLlmProviderResponse> {
  return requestJson<CreateLlmProviderResponse>(client, '/api/llm/providers', {
    method: 'POST',
    body,
    errorFallback,
  });
}

export async function updateLlmProvider(
  providerId: string,
  body: UpdateLlmProviderRequest,
  errorFallback = 'Failed to update provider',
  client: ApiClient = defaultApiClient
): Promise<UpdateLlmProviderResponse> {
  return requestJson<UpdateLlmProviderResponse>(client, `/api/llm/providers/${providerId}`, {
    method: 'PATCH',
    body,
    errorFallback,
  });
}
