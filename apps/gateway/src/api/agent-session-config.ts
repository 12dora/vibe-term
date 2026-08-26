import type { AgentWriteMode } from '@tmex/shared';
import { HOSTED_TOOL_KEYS } from '../agent/tools/hosted';
import { type AgentSessionRecord, getAgentSettings } from '../db/agent';
import { getLlmProviderById } from '../db/llm';
import { t } from '../i18n';

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

function parseCreateAgentSessionConfig(
  raw: Record<string, unknown>
): { ok: true; config: CreateAgentSessionConfig } | { ok: false; error: string } {
  let providerId: string | null = null;
  if (raw.providerId !== undefined && raw.providerId !== null) {
    if (typeof raw.providerId !== 'string' || !getLlmProviderById(raw.providerId)) {
      return { ok: false, error: t('apiError.llmProviderNotFound') };
    }
    providerId = raw.providerId;
  }

  let modelId: string | null = null;
  if (raw.modelId !== undefined && raw.modelId !== null) {
    if (typeof raw.modelId !== 'string' || !raw.modelId.trim()) {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    modelId = raw.modelId.trim();
  } else {
    modelId = getAgentSettings().defaultModelId;
  }
  if (!modelId) {
    return { ok: false, error: t('apiError.llmNoDefaultModel') };
  }

  if (raw.writeMode !== undefined && !WRITE_MODES.includes(raw.writeMode as AgentWriteMode)) {
    return { ok: false, error: t('apiError.agentWriteModeInvalid') };
  }

  if (raw.useProviderWebSearch !== undefined && typeof raw.useProviderWebSearch !== 'boolean') {
    return { ok: false, error: t('apiError.invalidRequest') };
  }
  if (raw.useProviderWebSearch) {
    const error = validateProviderWebSearch(providerId);
    if (error) {
      return { ok: false, error };
    }
  }

  const hostedTools = parseProviderHostedTools(raw.providerHostedTools, providerId);
  if ('error' in hostedTools) {
    return { ok: false, error: hostedTools.error };
  }

  if (raw.allowControlChars !== undefined && typeof raw.allowControlChars !== 'boolean') {
    return { ok: false, error: t('apiError.invalidRequest') };
  }

  if (
    raw.systemPrompt !== undefined &&
    raw.systemPrompt !== null &&
    typeof raw.systemPrompt !== 'string'
  ) {
    return { ok: false, error: t('apiError.invalidRequest') };
  }

  let maxStepsPerTurn: number | undefined;
  if (raw.maxStepsPerTurn !== undefined) {
    const validated = validateMaxSteps(raw.maxStepsPerTurn);
    if (typeof validated !== 'number') {
      return { ok: false, error: validated.error };
    }
    maxStepsPerTurn = validated;
  }

  const config: CreateAgentSessionConfig = {
    providerId,
    modelId,
    systemPrompt: (raw.systemPrompt as string | null | undefined) ?? null,
    useProviderWebSearch: (raw.useProviderWebSearch as boolean | undefined) ?? false,
    providerHostedTools: hostedTools.value,
    allowControlChars: (raw.allowControlChars as boolean | undefined) ?? false,
  };
  if (raw.writeMode !== undefined) {
    config.writeMode = raw.writeMode as AgentWriteMode;
  }
  if (maxStepsPerTurn !== undefined) {
    config.maxStepsPerTurn = maxStepsPerTurn;
  }
  return { ok: true, config };
}

function parseUpdateAgentSessionConfig(
  raw: Record<string, unknown>,
  existing: AgentSessionConfigExisting
): { ok: true; config: UpdateAgentSessionConfig } | { ok: false; error: string } {
  const config: UpdateAgentSessionConfig = {};

  if (raw.providerId !== undefined) {
    if (raw.providerId === null) {
      config.providerId = null;
    } else if (typeof raw.providerId !== 'string' || !getLlmProviderById(raw.providerId)) {
      return { ok: false, error: t('apiError.llmProviderNotFound') };
    } else {
      config.providerId = raw.providerId;
    }
  }

  if (raw.modelId !== undefined) {
    if (typeof raw.modelId !== 'string' || !raw.modelId.trim()) {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    config.modelId = raw.modelId.trim();
  }

  if (raw.systemPrompt !== undefined) {
    if (raw.systemPrompt !== null && typeof raw.systemPrompt !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    config.systemPrompt = raw.systemPrompt;
  }

  if (raw.writeMode !== undefined) {
    if (!WRITE_MODES.includes(raw.writeMode as AgentWriteMode)) {
      return { ok: false, error: t('apiError.agentWriteModeInvalid') };
    }
    config.writeMode = raw.writeMode as AgentWriteMode;
  }

  if (raw.useProviderWebSearch !== undefined) {
    if (typeof raw.useProviderWebSearch !== 'boolean') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    config.useProviderWebSearch = raw.useProviderWebSearch;
  }

  if (raw.providerHostedTools !== undefined) {
    const effectiveProviderId =
      config.providerId !== undefined ? config.providerId : existing.providerId;
    const hostedTools = parseProviderHostedTools(raw.providerHostedTools, effectiveProviderId);
    if ('error' in hostedTools) {
      return { ok: false, error: hostedTools.error };
    }
    config.providerHostedTools = hostedTools.value;
  }

  if (raw.allowControlChars !== undefined) {
    if (typeof raw.allowControlChars !== 'boolean') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    config.allowControlChars = raw.allowControlChars;
  }

  if (raw.maxStepsPerTurn !== undefined) {
    const validated = validateMaxSteps(raw.maxStepsPerTurn);
    if (typeof validated !== 'number') {
      return { ok: false, error: validated.error };
    }
    config.maxStepsPerTurn = validated;
  }

  if (config.useProviderWebSearch ?? existing.useProviderWebSearch) {
    const effectiveProviderId =
      config.providerId !== undefined ? config.providerId : existing.providerId;
    const error = validateProviderWebSearch(effectiveProviderId);
    if (error) {
      return { ok: false, error };
    }
  }

  return { ok: true, config };
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
