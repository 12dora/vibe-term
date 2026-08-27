import type { AgentWriteMode } from '@tmex/shared';
import { HOSTED_TOOL_KEYS } from '../agent/tools/hosted';
import { type AgentSessionRecord, getAgentSettings } from '../db/agent';
import { getLlmProviderById } from '../db/llm';
import { t } from '../i18n';
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseBooleanField,
  parseEnumField,
} from './config-field';

const WRITE_MODES: readonly AgentWriteMode[] = ['confirm', 'auto'];
const MAX_STEPS_MIN = 1;
const MAX_STEPS_MAX = 100;

export type AgentSessionConfigExisting = Pick<
  AgentSessionRecord,
  | 'providerId'
  | 'modelId'
  | 'systemPrompt'
  | 'writeMode'
  | 'useProviderWebSearch'
  | 'providerHostedTools'
  | 'allowControlChars'
  | 'maxStepsPerTurn'
>;

export interface CreateAgentSessionConfig {
  providerId: string | null;
  modelId: string;
  systemPrompt: string | null;
  writeMode?: AgentWriteMode;
  useProviderWebSearch: boolean;
  providerHostedTools: string[];
  allowControlChars: boolean;
  maxStepsPerTurn?: number;
}

export type UpdateAgentSessionConfig = Partial<{
  providerId: string | null;
  modelId: string;
  systemPrompt: string | null;
  writeMode: AgentWriteMode;
  useProviderWebSearch: boolean;
  providerHostedTools: string[];
  allowControlChars: boolean;
  maxStepsPerTurn: number;
}>;

export type ParseAgentSessionConfigResult =
  | { ok: true; config: CreateAgentSessionConfig | UpdateAgentSessionConfig }
  | { ok: false; error: string };

function validateProviderWebSearch(providerId: string | null): string | null {
  const effectiveProviderId = providerId ?? getAgentSettings().defaultProviderId;
  if (!effectiveProviderId) {
    return t('apiError.agentProviderWebSearchRequiresResponses');
  }
  const provider = getLlmProviderById(effectiveProviderId);
  if (!provider || provider.protocol !== 'openai-responses') {
    return t('apiError.agentProviderWebSearchRequiresResponses');
  }
  return null;
}

function parseProviderHostedTools(
  raw: unknown,
  providerId: string | null
): { value: string[] } | { error: string } {
  if (raw === undefined) {
    return { value: [] };
  }
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === 'string')) {
    return { error: t('apiError.invalidRequest') };
  }
  const keys = [...new Set(raw as string[])];
  const unknown = keys.find((key) => !HOSTED_TOOL_KEYS.includes(key));
  if (unknown) {
    return { error: t('apiError.agentHostedToolUnknown', { name: unknown }) };
  }
  if (keys.length > 0) {
    const effectiveProviderId = providerId ?? getAgentSettings().defaultProviderId;
    const provider = effectiveProviderId ? getLlmProviderById(effectiveProviderId) : null;
    if (!provider || provider.protocol !== 'openai-responses') {
      return { error: t('apiError.agentHostedToolRequiresResponses') };
    }
  }
  return { value: keys };
}

function validateMaxSteps(value: unknown): number | { error: string } {
  const parsed = Math.floor(Number(value));
  if (Number.isNaN(parsed) || parsed < MAX_STEPS_MIN || parsed > MAX_STEPS_MAX) {
    return { error: t('apiError.agentMaxStepsInvalid') };
  }
  return parsed;
}

type AgentFieldMode = 'create' | 'update';

interface AgentFieldCtx {
  mode: AgentFieldMode;
  existing?: AgentSessionConfigExisting;
  fields: Record<string, unknown>;
}

function isCreate(ctx: AgentFieldCtx): boolean {
  return ctx.mode === 'create';
}

function parseProviderIdValue(raw: unknown): FieldParseResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !getLlmProviderById(raw)) {
    return { ok: false, error: t('apiError.llmProviderNotFound') };
  }
  return { ok: true, value: raw };
}

function parseModelIdValue(raw: unknown, ctx: AgentFieldCtx): FieldParseResult<string> {
  if (raw === undefined || (raw === null && ctx.mode === 'create')) {
    const modelId = getAgentSettings().defaultModelId;
    if (!modelId) return { ok: false, error: t('apiError.llmNoDefaultModel') };
    return { ok: true, value: modelId };
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: t('apiError.invalidRequest') };
  }
  return { ok: true, value: raw.trim() };
}

function parseSystemPromptValue(raw: unknown): FieldParseResult<string | null> {
  if (raw !== null && typeof raw !== 'string') {
    return { ok: false, error: t('apiError.invalidRequest') };
  }
  return { ok: true, value: raw };
}

function parseMaxStepsValue(raw: unknown): FieldParseResult<number> {
  const validated = validateMaxSteps(raw);
  if (typeof validated !== 'number') return { ok: false, error: validated.error };
  return { ok: true, value: validated };
}

function parseHostedToolsValue(raw: unknown, ctx: AgentFieldCtx): FieldParseResult<string[]> {
  const providerId =
    ctx.fields.providerId !== undefined
      ? (ctx.fields.providerId as string | null)
      : (ctx.existing?.providerId ?? null);
  const hostedTools = parseProviderHostedTools(raw, providerId);
  if ('error' in hostedTools) return { ok: false, error: hostedTools.error };
  return { ok: true, value: hostedTools.value };
}

function createDefault<T>(value: T): (ctx: AgentFieldCtx) => AbsentActionFor<T> {
  return (ctx) => (isCreate(ctx) ? { default: value } : 'omit');
}

type AbsentActionFor<T> = 'omit' | 'parse' | { default: T };

const AGENT_SESSION_FIELDS: ConfigFieldSpec<unknown, AgentFieldCtx>[] = [
  {
    name: 'providerId',
    parse: parseProviderIdValue,
    onAbsent: createDefault(null),
    nullIsAbsent: isCreate,
  },
  {
    name: 'modelId',
    parse: parseModelIdValue,
    onAbsent: (ctx) => (isCreate(ctx) ? 'parse' : 'omit'),
    nullIsAbsent: isCreate,
  },
  {
    name: 'systemPrompt',
    parse: parseSystemPromptValue,
    onAbsent: createDefault(null),
  },
  {
    name: 'writeMode',
    parse: (raw) => parseEnumField(raw, WRITE_MODES, t('apiError.agentWriteModeInvalid')),
  },
  {
    name: 'useProviderWebSearch',
    parse: (raw) => parseBooleanField(raw, t('apiError.invalidRequest')),
    onAbsent: createDefault(false),
  },
  {
    name: 'providerHostedTools',
    parse: parseHostedToolsValue,
    onAbsent: createDefault<string[]>([]),
  },
  {
    name: 'allowControlChars',
    parse: (raw) => parseBooleanField(raw, t('apiError.invalidRequest')),
    onAbsent: createDefault(false),
  },
  {
    name: 'maxStepsPerTurn',
    parse: parseMaxStepsValue,
  },
];

function effectiveProviderId(
  fields: { providerId?: string | null },
  existing?: AgentSessionConfigExisting
): string | null {
  return fields.providerId !== undefined ? fields.providerId : (existing?.providerId ?? null);
}

function validateWebSearchIfNeeded(
  fields: { providerId?: string | null; useProviderWebSearch?: boolean },
  existing?: AgentSessionConfigExisting
): string | null {
  const enabled = existing
    ? (fields.useProviderWebSearch ?? existing.useProviderWebSearch)
    : Boolean(fields.useProviderWebSearch);
  if (!enabled) return null;
  return validateProviderWebSearch(effectiveProviderId(fields, existing));
}

function parseCreateAgentSessionConfig(
  raw: Record<string, unknown>
): { ok: true; config: CreateAgentSessionConfig } | { ok: false; error: string } {
  const parsed = applyConfigFields<CreateAgentSessionConfig, AgentFieldCtx>(
    raw,
    AGENT_SESSION_FIELDS,
    { mode: 'create', fields: {} }
  );
  if (!parsed.ok) return parsed;
  const error = validateWebSearchIfNeeded(parsed.fields);
  if (error) return { ok: false, error };
  return { ok: true, config: parsed.fields };
}

function parseUpdateAgentSessionConfig(
  raw: Record<string, unknown>,
  existing: AgentSessionConfigExisting
): { ok: true; config: UpdateAgentSessionConfig } | { ok: false; error: string } {
  const parsed = applyConfigFields<UpdateAgentSessionConfig, AgentFieldCtx>(
    raw,
    AGENT_SESSION_FIELDS,
    { mode: 'update', existing, fields: {} }
  );
  if (!parsed.ok) return parsed;
  const error = validateWebSearchIfNeeded(parsed.fields, existing);
  if (error) return { ok: false, error };
  return { ok: true, config: parsed.fields };
}

export function parseAgentSessionConfig(
  raw: Record<string, unknown>
): { ok: true; config: CreateAgentSessionConfig } | { ok: false; error: string };
export function parseAgentSessionConfig(
  raw: Record<string, unknown>,
  existing: AgentSessionConfigExisting
): { ok: true; config: UpdateAgentSessionConfig } | { ok: false; error: string };
export function parseAgentSessionConfig(
  raw: Record<string, unknown>,
  existing?: AgentSessionConfigExisting
): ParseAgentSessionConfigResult {
  if (existing !== undefined) {
    return parseUpdateAgentSessionConfig(raw, existing);
  }
  return parseCreateAgentSessionConfig(raw);
}
