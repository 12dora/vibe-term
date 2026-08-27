import type { WatchFireMode, WatchNoMatchBehavior, WatchTriggerType } from '@tmex/shared';
import { getLlmProviderById } from '../db/llm';
import type { WatchRuleRecord } from '../db/watch';
import { t } from '../i18n';
import { compileWatchPattern } from '../watch/evaluator';
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseBooleanField,
  parseEnumField,
  parseIntegerField,
} from './config-field';

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

function invalidRequest(): string {
  return t('apiError.invalidRequest');
}

function parseNullablePattern(raw: unknown): FieldParseResult<string | null> {
  if (raw !== null && typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: typeof raw === 'string' && raw ? raw : null };
}

function parseNullablePrompt(raw: unknown): FieldParseResult<string | null> {
  if (raw !== null && typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: typeof raw === 'string' && raw.trim() ? raw : null };
}

function parseProviderIdField(raw: unknown): FieldParseResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string' || !getLlmProviderById(raw)) {
    return { ok: false, error: t('apiError.llmProviderNotFound') };
  }
  return { ok: true, value: raw };
}

function parseModelIdField(raw: unknown): FieldParseResult<string | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: invalidRequest() };
  return { ok: true, value: raw.trim() || null };
}

function parseNullablePositiveInt(raw: unknown, error: string): FieldParseResult<number | null> {
  if (raw === null) return { ok: true, value: null };
  return parseIntegerField(raw, error, (n) => n > 0);
}

const RULE_FIELD_SPECS: ConfigFieldSpec<unknown>[] = [
  { name: 'enabled', parse: (raw) => parseBooleanField(raw, invalidRequest()) },
  { name: 'pattern', parse: parseNullablePattern },
  {
    name: 'patternFlags',
    parse: (raw) =>
      typeof raw === 'string' ? { ok: true, value: raw } : { ok: false, error: invalidRequest() },
  },
  {
    name: 'extractGroup',
    parse: (raw) => parseIntegerField(raw, t('apiError.watchExtractGroupInvalid'), (n) => n >= 0),
  },
  { name: 'conditionPrompt', parse: parseNullablePrompt },
  { name: 'providerId', parse: parseProviderIdField },
  { name: 'modelId', parse: parseModelIdField },
  { name: 'confirmWithLlm', parse: (raw) => parseBooleanField(raw, invalidRequest()) },
  { name: 'summarizeWithLlm', parse: (raw) => parseBooleanField(raw, invalidRequest()) },
  {
    name: 'intervalSeconds',
    parse: (raw) => parseIntegerField(raw, invalidRequest()),
  },
  {
    name: 'unchangedMinutes',
    parse: (raw) => parseNullablePositiveInt(raw, t('apiError.watchUnchangedMinutesInvalid')),
  },
  {
    name: 'noMatchBehavior',
    parse: (raw) =>
      parseEnumField(raw, NO_MATCH_BEHAVIORS, t('apiError.watchNoMatchBehaviorInvalid')),
  },
  {
    name: 'fireMode',
    parse: (raw) => parseEnumField(raw, FIRE_MODES, t('apiError.watchFireModeInvalid')),
  },
  {
    name: 'cooldownSeconds',
    parse: (raw) => parseIntegerField(raw, t('apiError.watchCooldownInvalid'), (n) => n >= 0),
  },
];

function parseRuleFields(
  body: Record<string, unknown>
): { ok: true; fields: WatchRuleUpdates } | { ok: false; error: string } {
  return applyConfigFields<WatchRuleUpdates>(body, RULE_FIELD_SPECS, undefined);
}

function coalesceDefined<T>(patched: T | undefined, existing: T | undefined, fallback: T): T {
  if (patched !== undefined) return patched;
  if (existing !== undefined) return existing;
  return fallback;
}

export function parseWatchTriggerType(
  patch: Record<string, unknown>,
  existing: WatchRuleExisting | null
): FieldParseResult<WatchTriggerType> {
  if (patch.triggerType !== undefined) {
    return parseEnumField(patch.triggerType, TRIGGER_TYPES, t('apiError.watchTriggerTypeInvalid'));
  }
  if (existing) return { ok: true, value: existing.triggerType };
  return { ok: false, error: t('apiError.watchTriggerTypeInvalid') };
}

export function mergeWatchRuleEffective(
  existing: WatchRuleExisting | null,
  fields: WatchRuleUpdates,
  triggerType: WatchTriggerType
): WatchRuleEffective {
  return {
    triggerType,
    pattern: coalesceDefined(fields.pattern, existing?.pattern, null),
    patternFlags: coalesceDefined(fields.patternFlags, existing?.patternFlags, ''),
    unchangedMinutes: coalesceDefined(fields.unchangedMinutes, existing?.unchangedMinutes, null),
    conditionPrompt: coalesceDefined(fields.conditionPrompt, existing?.conditionPrompt, null),
    intervalSeconds: coalesceDefined(
      fields.intervalSeconds,
      existing?.intervalSeconds,
      triggerType === 'llm' ? 60 : 30
    ),
  };
}

function validatePatternTrigger(input: WatchRuleEffective): string | null {
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
  if (
    input.triggerType === 'unchanged' &&
    (!input.unchangedMinutes || input.unchangedMinutes <= 0)
  ) {
    return t('apiError.watchUnchangedMinutesInvalid');
  }
  return null;
}

export function validateRuleSemantics(input: WatchRuleEffective): string | null {
  if (input.triggerType === 'match' || input.triggerType === 'unchanged') {
    const error = validatePatternTrigger(input);
    if (error) return error;
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
  const trigger = parseWatchTriggerType(patch, existing);
  if (!trigger.ok) return trigger;

  const parsed = parseRuleFields(patch);
  if (!parsed.ok) return parsed;

  const updates: WatchRuleUpdates = { ...parsed.fields };
  if (patch.triggerType !== undefined) {
    updates.triggerType = trigger.value;
  }

  const effective = mergeWatchRuleEffective(existing, parsed.fields, trigger.value);
  const semanticError = validateRuleSemantics(effective);
  if (semanticError) {
    return { ok: false, error: semanticError };
  }

  return { ok: true, updates, effective };
}
