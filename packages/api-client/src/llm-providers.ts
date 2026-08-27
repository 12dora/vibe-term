// LLM providers / Agent LLM 设置 REST 端点

import type {
  CreateLlmProviderRequest,
  CreateLlmProviderResponse,
  GetAgentLlmSettingsResponse,
  ListLlmProvidersResponse,
  UpdateLlmProviderRequest,
  UpdateLlmProviderResponse,
} from '@tmex/shared';
import { type ApiClient, defaultApiClient, parseApiError } from './client';

export const llmProvidersQueryKey = ['llm-providers'] as const;
export const llmSettingsQueryKey = ['llm-settings'] as const;

export async function fetchLlmProviders(
  errorFallback = 'Failed to load providers',
  client: ApiClient = defaultApiClient
): Promise<ListLlmProvidersResponse> {
  const res = await client.fetch('/api/llm/providers');
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as ListLlmProvidersResponse;
}

export async function fetchAgentLlmSettings(
  errorFallback = 'Failed to load LLM settings',
  client: ApiClient = defaultApiClient
): Promise<GetAgentLlmSettingsResponse> {
  const res = await client.fetch('/api/llm/settings');
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as GetAgentLlmSettingsResponse;
}

export async function createLlmProvider(
  body: CreateLlmProviderRequest,
  errorFallback = 'Failed to create provider',
  client: ApiClient = defaultApiClient
): Promise<CreateLlmProviderResponse> {
  const res = await client.fetch('/api/llm/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as CreateLlmProviderResponse;
}

export async function updateLlmProvider(
  providerId: string,
  body: UpdateLlmProviderRequest,
  errorFallback = 'Failed to update provider',
  client: ApiClient = defaultApiClient
): Promise<UpdateLlmProviderResponse> {
  const res = await client.fetch(`/api/llm/providers/${providerId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, errorFallback));
  }
  return (await res.json()) as UpdateLlmProviderResponse;
}
