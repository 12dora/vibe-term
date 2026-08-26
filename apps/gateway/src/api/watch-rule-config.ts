import type { WatchFireMode, WatchNoMatchBehavior, WatchTriggerType } from '@tmex/shared';
import { getLlmProviderById } from '../db/llm';
import type { WatchRuleRecord } from '../db/watch';
import { t } from '../i18n';
import { compileWatchPattern } from '../watch/evaluator';

const TRIGGER_TYPES: readonly WatchTriggerType[] = ['match', 'unchanged', 'llm'];
const NO_MATCH_BEHAVIORS: readonly WatchNoMatchBehavior[] = ['reset', 'ignore'];
const FIRE_MODES: readonly WatchFireMode[] = ['once', 'repeat'];

export type WatchRuleExisting = Pick<
  WatchRuleRecord,
  | 'triggerType'
  | 'pattern'
  | 'patternFlags'
  | 'unchangedMinutes'
  | 'conditionPrompt'
  | 'intervalSeconds'
>;

export interface WatchRuleUpdates {
  triggerType?: WatchTriggerType;
  enabled?: boolean;
  pattern?: string | null;
  patternFlags?: string;
  extractGroup?: number;
  conditionPrompt?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  confirmWithLlm?: boolean;
  summarizeWithLlm?: boolean;
  intervalSeconds?: number;
  unchangedMinutes?: number | null;
  noMatchBehavior?: WatchNoMatchBehavior;
  fireMode?: WatchFireMode;
  cooldownSeconds?: number;
}

export interface WatchRuleEffective {
  triggerType: WatchTriggerType;
  pattern: string | null;
  patternFlags: string;
  unchangedMinutes: number | null;
  conditionPrompt: string | null;
  intervalSeconds: number;
}

export type BuildEffectiveWatchRuleResult =
  | { ok: true; updates: WatchRuleUpdates; effective: WatchRuleEffective }
  | { ok: false; error: string };

function parseRuleFields(
  body: Record<string, unknown>
): { ok: true; fields: WatchRuleUpdates } | { ok: false; error: string } {
  const fields: WatchRuleUpdates = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.enabled = body.enabled;
  }

  if (body.pattern !== undefined) {
    if (body.pattern !== null && typeof body.pattern !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.pattern = typeof body.pattern === 'string' && body.pattern ? body.pattern : null;
  }

  if (body.patternFlags !== undefined) {
    if (typeof body.patternFlags !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.patternFlags = body.patternFlags;
  }

  if (body.extractGroup !== undefined) {
    if (
      typeof body.extractGroup !== 'number' ||
      !Number.isInteger(body.extractGroup) ||
      body.extractGroup < 0
    ) {
      return { ok: false, error: t('apiError.watchExtractGroupInvalid') };
    }
    fields.extractGroup = body.extractGroup;
  }

  if (body.conditionPrompt !== undefined) {
    if (body.conditionPrompt !== null && typeof body.conditionPrompt !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.conditionPrompt =
      typeof body.conditionPrompt === 'string' && body.conditionPrompt.trim()
        ? body.conditionPrompt
        : null;
  }

  if (body.providerId !== undefined) {
    if (body.providerId === null) {
      fields.providerId = null;
    } else if (typeof body.providerId !== 'string' || !getLlmProviderById(body.providerId)) {
      return { ok: false, error: t('apiError.llmProviderNotFound') };
    } else {
      fields.providerId = body.providerId;
    }
  }

  if (body.modelId !== undefined) {
    if (body.modelId === null) {
      fields.modelId = null;
    } else if (typeof body.modelId !== 'string') {
      return { ok: false, error: t('apiError.invalidRequest') };
    } else {
      fields.modelId = body.modelId.trim() || null;
    }
  }

  for (const key of ['confirmWithLlm', 'summarizeWithLlm'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') {
        return { ok: false, error: t('apiError.invalidRequest') };
      }
      fields[key] = body[key];
    }
  }

  if (body.intervalSeconds !== undefined) {
    if (typeof body.intervalSeconds !== 'number' || !Number.isInteger(body.intervalSeconds)) {
      return { ok: false, error: t('apiError.invalidRequest') };
    }
    fields.intervalSeconds = body.intervalSeconds;
  }

  if (body.unchangedMinutes !== undefined) {
    if (body.unchangedMinutes === null) {
      fields.unchangedMinutes = null;
    } else if (
      typeof body.unchangedMinutes !== 'number' ||
      !Number.isInteger(body.unchangedMinutes) ||
      body.unchangedMinutes <= 0
    ) {
      return { ok: false, error: t('apiError.watchUnchangedMinutesInvalid') };
    } else {
      fields.unchangedMinutes = body.unchangedMinutes;
    }
  }

  if (body.noMatchBehavior !== undefined) {
    if (!NO_MATCH_BEHAVIORS.includes(body.noMatchBehavior as WatchNoMatchBehavior)) {
      return { ok: false, error: t('apiError.watchNoMatchBehaviorInvalid') };
    }
    fields.noMatchBehavior = body.noMatchBehavior as WatchNoMatchBehavior;
  }

  if (body.fireMode !== undefined) {
    if (!FIRE_MODES.includes(body.fireMode as WatchFireMode)) {
      return { ok: false, error: t('apiError.watchFireModeInvalid') };
    }
    fields.fireMode = body.fireMode as WatchFireMode;
  }

  if (body.cooldownSeconds !== undefined) {
    if (
      typeof body.cooldownSeconds !== 'number' ||
      !Number.isInteger(body.cooldownSeconds) ||
      body.cooldownSeconds < 0
    ) {
      return { ok: false, error: t('apiError.watchCooldownInvalid') };
    }
    fields.cooldownSeconds = body.cooldownSeconds;
  }

  return { ok: true, fields };
}

function validateRuleSemantics(input: WatchRuleEffective): string | null {
  if (input.triggerType === 'match' || input.triggerType === 'unchanged') {
    if (!input.pattern) {
      return t('apiError.watchPatternRequired');
    }
    try {
      compileWatchPattern(input.pattern, input.patternFlags);
    } catch (error) {
      return t('apiError.watchPatternInvalid', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (input.triggerType === 'unchanged') {
      if (!input.unchangedMinutes || input.unchangedMinutes <= 0) {
        return t('apiError.watchUnchangedMinutesInvalid');
      }
    }
  } else if (!input.conditionPrompt?.trim()) {
    return t('apiError.watchConditionPromptRequired');
  }

  const minInterval = input.triggerType === 'llm' ? 30 : 5;
  if (input.intervalSeconds < minInterval) {
    return t('apiError.watchIntervalInvalid', { min: minInterval });
  }

  return null;
}

export function buildEffectiveWatchRule(
  existing: WatchRuleExisting | null,
  patch: Record<string, unknown>
): BuildEffectiveWatchRuleResult {
  if (patch.triggerType !== undefined) {
    if (!TRIGGER_TYPES.includes(patch.triggerType as WatchTriggerType)) {
      return { ok: false, error: t('apiError.watchTriggerTypeInvalid') };
    }
  } else if (!existing) {
    return { ok: false, error: t('apiError.watchTriggerTypeInvalid') };
  }

  const parsed = parseRuleFields(patch);
  if (!parsed.ok) {
    return parsed;
  }

  const updates: WatchRuleUpdates = { ...parsed.fields };
  if (patch.triggerType !== undefined) {
    updates.triggerType = patch.triggerType as WatchTriggerType;
  }

  const triggerType = updates.triggerType ?? existing?.triggerType;
  if (!triggerType) {
    return { ok: false, error: t('apiError.watchTriggerTypeInvalid') };
  }

  const effective: WatchRuleEffective = {
    triggerType,
    pattern:
      parsed.fields.pattern !== undefined ? parsed.fields.pattern : (existing?.pattern ?? null),
    patternFlags:
      parsed.fields.patternFlags !== undefined
        ? parsed.fields.patternFlags
        : (existing?.patternFlags ?? ''),
    unchangedMinutes:
      parsed.fields.unchangedMinutes !== undefined
        ? parsed.fields.unchangedMinutes
        : (existing?.unchangedMinutes ?? null),
    conditionPrompt:
      parsed.fields.conditionPrompt !== undefined
        ? parsed.fields.conditionPrompt
        : (existing?.conditionPrompt ?? null),
    intervalSeconds:
      parsed.fields.intervalSeconds !== undefined
        ? parsed.fields.intervalSeconds
        : (existing?.intervalSeconds ?? (triggerType === 'llm' ? 60 : 30)),
  };

  const semanticError = validateRuleSemantics(effective);
  if (semanticError) {
    return { ok: false, error: semanticError };
  }

  return { ok: true, updates, effective };
}
