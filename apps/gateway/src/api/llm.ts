import type {
  AgentLlmSettingsDto,
  CreateLlmProviderRequest,
  LlmProviderDto,
  LlmProviderProtocol,
  SearchProviderInfoDto,
} from '@tmex/shared';
import { getSearchProviders } from '../agent/tools/web';
import { encrypt } from '../crypto';
import { getAgentSettings, updateAgentSettings } from '../db/agent';
import type { AgentSettingsRecord } from '../db/agent';
import {
  type LlmProviderRecord,
  type UpdateLlmProviderInput,
  computeProviderModels,
  createLlmProvider,
  deleteLlmProvider,
  getAllLlmProviders,
  getLlmProviderById,
  updateLlmProvider,
} from '../db/llm';
import { t } from '../i18n';
import { fetchProviderModels } from '../llm/provider-registry';
import { broadcastSettingsUpdate } from '../settings/broadcaster';
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseBooleanField,
  parseEnumField,
  parseStringArrayField,
  uniqueTrimmedStrings,
} from './config-field';
import { json, readJsonObjectBody } from './http';
import { type AgentLlmSettingsDraft, parseUpdateSettingsFields } from './llm-settings-fields';
import { type ApiRoute, route } from './route';

const PROTOCOLS: readonly LlmProviderProtocol[] = ['openai-chat', 'openai-responses'];

function toSearchProviderInfos(settings: AgentSettingsRecord): SearchProviderInfoDto[] {
  return getSearchProviders().map((provider) => ({
    id: provider.id,
    label: provider.label,
    isConfigured: provider.isConfigured(settings),
  }));
}

function toProviderDto(record: LlmProviderRecord): LlmProviderDto {
  const { effective, modelDetails } = computeProviderModels(record);
  return {
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    baseUrl: record.baseUrl,
    hasApiKey: record.apiKeyEnc.length > 0,
    enabled: record.enabled,
    models: effective,
    modelDetails,
    modelsFetchedAt: record.modelsFetchedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toSettingsDto(record: AgentSettingsRecord): AgentLlmSettingsDto {
  return {
    searchProvider: record.searchProvider,
    hasTavilyApiKey: Boolean(record.tavilyApiKeyEnc),
    hasBraveApiKey: Boolean(record.braveApiKeyEnc),
    defaultProviderId: record.defaultProviderId,
    defaultModelId: record.defaultModelId,
    updatedAt: record.updatedAt,
  };
}

function isValidBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

async function refreshModelsCache(
  provider: LlmProviderRecord
): Promise<{ provider: LlmProviderRecord; models?: string[]; modelsError?: string }> {
  try {
    const models = await fetchProviderModels(provider);
    const updated = updateLlmProvider(provider.id, {
      modelsCache: models,
      modelsFetchedAt: new Date().toISOString(),
    });
    return { provider: updated ?? provider, models };
  } catch (error) {
    // 服务端日志打原始技术错误（cause），而非给前端 toast 的 i18n 文案。
    const raw = error instanceof Error && error.cause !== undefined ? error.cause : error;
    console.warn(
      `[llm] 拉取模型列表失败 provider=${provider.name}(${provider.id}) baseUrl=${provider.baseUrl}:`,
      raw
    );
    return {
      provider,
      modelsError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleListProviders(): Promise<Response> {
  const providers = getAllLlmProviders().map(toProviderDto);
  return json({ providers });
}

async function handleCreateProvider(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }
  const body = raw as unknown as CreateLlmProviderRequest;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return json({ error: t('apiError.llmProviderNameRequired') }, 400);
  }
  if (!PROTOCOLS.includes(body.protocol)) {
    return json({ error: t('apiError.llmProviderProtocolInvalid') }, 400);
  }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
  if (!baseUrl || !isValidBaseUrl(baseUrl)) {
    return json({ error: t('apiError.llmProviderBaseUrlInvalid') }, 400);
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    return json({ error: t('apiError.llmProviderApiKeyRequired') }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const created = createLlmProvider({
    name,
    protocol: body.protocol,
    baseUrl,
    apiKeyEnc: await encrypt(apiKey),
    enabled: body.enabled ?? true,
  });

  const { provider, modelsError } = await refreshModelsCache(created);
  broadcastSettingsUpdate('llm');
  return json({ provider: toProviderDto(provider), ...(modelsError ? { modelsError } : {}) }, 201);
}

type ProviderUpdateDraft = UpdateLlmProviderInput & { apiKey?: string };

function parseTrimmedModelList(raw: unknown): FieldParseResult<string[]> {
  const parsed = parseStringArrayField(raw, t('apiError.invalidRequest'));
  if (!parsed.ok) return parsed;
  return { ok: true, value: uniqueTrimmedStrings(parsed.value) };
}

const PROVIDER_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  {
    name: 'name',
    parse: (raw) => {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) return { ok: false, error: t('apiError.llmProviderNameRequired') };
      return { ok: true, value: name };
    },
  },
  {
    name: 'protocol',
    parse: (raw) => parseEnumField(raw, PROTOCOLS, t('apiError.llmProviderProtocolInvalid')),
  },
  {
    name: 'baseUrl',
    parse: (raw) => {
      const baseUrl = typeof raw === 'string' ? raw.trim() : '';
      if (!isValidBaseUrl(baseUrl)) {
        return { ok: false, error: t('apiError.llmProviderBaseUrlInvalid') };
      }
      return { ok: true, value: baseUrl };
    },
  },
  {
    name: 'apiKey',
    parse: (raw) =>
      typeof raw === 'string'
        ? { ok: true, value: raw.trim() }
        : { ok: false, error: t('apiError.invalidRequest') },
  },
  {
    name: 'enabled',
    parse: (raw) => parseBooleanField(raw, t('apiError.invalidRequest')),
  },
  { name: 'manualModels', parse: parseTrimmedModelList },
  { name: 'disabledModels', parse: parseTrimmedModelList },
];

function parseUpdateProviderFields(
  raw: Record<string, unknown>
): { ok: true; draft: ProviderUpdateDraft } | { ok: false; error: string } {
  const parsed = applyConfigFields<ProviderUpdateDraft>(raw, PROVIDER_UPDATE_FIELDS, undefined);
  if (!parsed.ok) return parsed;
  return { ok: true, draft: parsed.fields };
}

async function handleUpdateProvider(req: Request, id: string): Promise<Response> {
  const existing = getLlmProviderById(id);
  if (!existing) return json({ error: t('apiError.llmProviderNotFound') }, 404);

  const raw = await readJsonObjectBody(req);
  if (!raw) return json({ error: t('apiError.invalidRequest') }, 400);

  const parsed = parseUpdateProviderFields(raw);
  if (!parsed.ok) return json({ error: parsed.error }, 400);

  const { apiKey, ...fieldUpdates } = parsed.draft;
  const updates: UpdateLlmProviderInput = { ...fieldUpdates };
  if (apiKey) updates.apiKeyEnc = await encrypt(apiKey);

  let provider = updateLlmProvider(id, updates);
  if (!provider) return json({ error: t('apiError.llmProviderNotFound') }, 404);

  const credentialsChanged =
    (updates.baseUrl !== undefined && updates.baseUrl !== existing.baseUrl) ||
    updates.apiKeyEnc !== undefined;

  let modelsError: string | undefined;
  if (credentialsChanged) {
    const refreshed = await refreshModelsCache(provider);
    provider = refreshed.provider;
    modelsError = refreshed.modelsError;
  }

  broadcastSettingsUpdate('llm');
  return json({ provider: toProviderDto(provider), ...(modelsError ? { modelsError } : {}) });
}

async function handleDeleteProvider(id: string): Promise<Response> {
  const existing = getLlmProviderById(id);
  if (!existing) {
    return json({ error: t('apiError.llmProviderNotFound') }, 404);
  }

  deleteLlmProvider(id);
  broadcastSettingsUpdate('llm');
  return json({ success: true });
}

async function handleRefreshProviderModels(id: string): Promise<Response> {
  const existing = getLlmProviderById(id);
  if (!existing) {
    return json({ error: t('apiError.llmProviderNotFound') }, 404);
  }

  const { models, modelsError } = await refreshModelsCache(existing);
  if (modelsError !== undefined || models === undefined) {
    return json({ error: modelsError ?? t('apiError.invalidRequest') }, 502);
  }

  return json({ models });
}

async function handleGetSettings(): Promise<Response> {
  const record = getAgentSettings();
  return json({
    settings: toSettingsDto(record),
    searchProviders: toSearchProviderInfos(record),
  });
}

async function toAgentSettingsPatch(
  draft: AgentLlmSettingsDraft
): Promise<Parameters<typeof updateAgentSettings>[0]> {
  const { tavilyApiKey, braveApiKey, ...rest } = draft;
  const updates: Parameters<typeof updateAgentSettings>[0] = { ...rest };
  if (tavilyApiKey !== undefined) {
    updates.tavilyApiKeyEnc = tavilyApiKey ? await encrypt(tavilyApiKey) : null;
  }
  if (braveApiKey !== undefined) {
    updates.braveApiKeyEnc = braveApiKey ? await encrypt(braveApiKey) : null;
  }
  return updates;
}

async function handleUpdateSettings(req: Request): Promise<Response> {
  const raw = await readJsonObjectBody(req);
  if (!raw) {
    return json({ error: t('apiError.invalidRequest') }, 400);
  }

  const parsed = parseUpdateSettingsFields(raw);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }

  const settings = updateAgentSettings(await toAgentSettingsPatch(parsed.fields));
  broadcastSettingsUpdate('llm');
  return json({ settings: toSettingsDto(settings) });
}

export const llmRoutes: ApiRoute[] = [
  route({ method: 'GET', path: '/api/llm/providers', handler: () => handleListProviders() }),
  route({
    method: 'POST',
    path: '/api/llm/providers',
    handler: (req) => handleCreateProvider(req),
  }),
  route({
    method: 'PATCH',
    path: '/api/llm/providers/:id',
    handler: (req, params) => handleUpdateProvider(req, params.id),
  }),
  route({
    method: 'DELETE',
    path: '/api/llm/providers/:id',
    handler: (_req, params) => handleDeleteProvider(params.id),
  }),
  route({
    method: 'POST',
    path: '/api/llm/providers/:id/refresh-models',
    handler: (_req, params) => handleRefreshProviderModels(params.id),
  }),
  route({ method: 'GET', path: '/api/llm/settings', handler: () => handleGetSettings() }),
  route({
    method: 'PATCH',
    path: '/api/llm/settings',
    handler: (req) => handleUpdateSettings(req),
  }),
];
