import { getSearchProvider } from '../agent/tools/web';
import { getLlmProviderById } from '../db/llm';
import { t } from '../i18n';
import { type ConfigFieldSpec, type FieldParseResult, applyConfigFields } from './config-field';

export type AgentLlmSettingsDraft = {
  searchProvider?: string;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  tavilyApiKey?: string;
  braveApiKey?: string;
};

function invalidRequest(): string {
  return t('apiError.invalidRequest');
}

function isValidSearchProvider(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return value === 'none' || getSearchProvider(value) !== undefined;
}

function parseSearchProvider(raw: unknown): FieldParseResult<string> {
  if (!isValidSearchProvider(raw)) {
    return { ok: false, error: t('apiError.llmSearchProviderInvalid') };
  }
  return { ok: true, value: raw };
}

function parseDefaultProviderId(raw: unknown): FieldParseResult<string | null> {
  if (raw !== null && typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  if (raw !== null && !getLlmProviderById(raw)) {
    return { ok: false, error: t('apiError.llmDefaultProviderNotFound') };
  }
  return { ok: true, value: raw };
}

function parseNullableString(raw: unknown): FieldParseResult<string | null> {
  if (raw !== null && typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: raw };
}

function parseTrimmedString(raw: unknown): FieldParseResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: raw.trim() };
}

const SETTINGS_UPDATE_FIELDS: ConfigFieldSpec<unknown>[] = [
  { name: 'searchProvider', parse: parseSearchProvider },
  { name: 'defaultProviderId', parse: parseDefaultProviderId },
  { name: 'defaultModelId', parse: parseNullableString },
  { name: 'tavilyApiKey', parse: parseTrimmedString },
  { name: 'braveApiKey', parse: parseTrimmedString },
];

export function parseUpdateSettingsFields(
  raw: Record<string, unknown>
): { ok: true; fields: AgentLlmSettingsDraft } | { ok: false; error: string } {
  return applyConfigFields<AgentLlmSettingsDraft>(raw, SETTINGS_UPDATE_FIELDS, undefined);
}
