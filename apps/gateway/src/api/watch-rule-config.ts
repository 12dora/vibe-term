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

interface RuleFieldCtx {
  existing: WatchRuleExisting | null;
}

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

const RULE_FIELD_SPECS: ConfigFieldSpec<unknown, RuleFieldCtx>[] = [
  {
    name: 'triggerType',
    parse: (raw) => parseEnumField(raw, TRIGGER_TYPES, t('apiError.watchTriggerTypeInvalid')),
    onAbsent: (ctx) => (ctx.existing ? 'omit' : 'parse'),
  },
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
  body: Record<string, unknown>,
  existing: WatchRuleExisting | null
): { ok: true; fields: WatchRuleUpdates } | { ok: false; error: string } {
  return applyConfigFields<WatchRuleUpdates, RuleFieldCtx>(body, RULE_FIELD_SPECS, { existing });
}

function coalesce<T>(patched: T | undefined, current: T | undefined, fallback: T): T {
  return patched !== undefined ? patched : (current ?? fallback);
}

function resolveEffective(
  updates: WatchRuleUpdates,
  existing: WatchRuleExisting | null,
  triggerType: WatchTriggerType
): WatchRuleEffective {
  return {
    triggerType,
    pattern: coalesce(updates.pattern, existing?.pattern, null),
    patternFlags: coalesce(updates.patternFlags, existing?.patternFlags, ''),
    unchangedMinutes: coalesce(updates.unchangedMinutes, existing?.unchangedMinutes, null),
    conditionPrompt: coalesce(updates.conditionPrompt, existing?.conditionPrompt, null),
    intervalSeconds: coalesce(
      updates.intervalSeconds,
      existing?.intervalSeconds,
      triggerType === 'llm' ? 60 : 30
    ),
  };
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
  const parsed = parseRuleFields(patch, existing);
  if (!parsed.ok) {
    return parsed;
  }

  const updates = parsed.fields;
  const triggerType = updates.triggerType ?? existing?.triggerType;
  if (!triggerType) {
    return { ok: false, error: t('apiError.watchTriggerTypeInvalid') };
  }

  const effective = resolveEffective(updates, existing, triggerType);
  const semanticError = validateRuleSemantics(effective);
  if (semanticError) {
    return { ok: false, error: semanticError };
  }

  return { ok: true, updates, effective };
}
