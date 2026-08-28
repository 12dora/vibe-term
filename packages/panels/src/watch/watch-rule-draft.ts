import type {
  AssistRegexRequest,
  AssistRegexResponse,
  CreateWatchRuleRequest,
  UpdateWatchRuleRequest,
  WatchFireMode,
  WatchNoMatchBehavior,
  WatchRuleDto,
  WatchTriggerType,
} from '@tmex/shared';

export const TRIGGER_TYPES: WatchTriggerType[] = ['match', 'unchanged', 'llm'];
export const FOLLOW_DEFAULT_VALUE = '__default__';

export interface WatchRuleDraft {
  name: string;
  triggerType: WatchTriggerType;
  pattern: string;
  patternFlags: string;
  extractGroup: number;
  unchangedMinutes: number;
  noMatchBehavior: WatchNoMatchBehavior;
  conditionPrompt: string;
  providerId: string | null;
  modelId: string;
  confirmWithLlm: boolean;
  summarizeWithLlm: boolean;
  intervalSeconds: number;
  fireMode: WatchFireMode;
  cooldownSeconds: number;
}

export type WatchRuleValidationKey =
  | 'watch.validation.nameRequired'
  | 'watch.validation.patternRequired'
  | 'watch.validation.patternInvalid'
  | 'watch.validation.unchangedMinutesInvalid'
  | 'watch.validation.conditionPromptRequired'
  | 'watch.validation.intervalMin';

export interface WatchRuleValidationError {
  key: WatchRuleValidationKey;
  params?: Record<string, string | number>;
}

export type WatchRulePayload = Required<Omit<UpdateWatchRuleRequest, 'paneId' | 'enabled'>>;

export function minIntervalFor(triggerType: WatchTriggerType): number {
  return triggerType === 'llm' ? 30 : 5;
}

export function isRegexTrigger(triggerType: WatchTriggerType): boolean {
  return triggerType === 'match' || triggerType === 'unchanged';
}

export function needsModelFor(draft: WatchRuleDraft): boolean {
  return draft.triggerType === 'llm' || draft.confirmWithLlm || draft.summarizeWithLlm;
}

/** 新建草稿的全部默认值；编辑既有规则时同样用作各字段的空值回落 */
export const WATCH_RULE_DRAFT_DEFAULTS: WatchRuleDraft = {
  name: '',
  triggerType: 'match',
  pattern: '',
  patternFlags: '',
  extractGroup: 0,
  unchangedMinutes: 10,
  noMatchBehavior: 'reset',
  conditionPrompt: '',
  providerId: null,
  modelId: '',
  confirmWithLlm: false,
  summarizeWithLlm: false,
  intervalSeconds: 30,
  fireMode: 'once',
  cooldownSeconds: 600,
};

type MatchFields = Pick<
  WatchRuleDraft,
  'pattern' | 'patternFlags' | 'extractGroup' | 'unchangedMinutes' | 'noMatchBehavior'
>;
type LlmFields = Pick<
  WatchRuleDraft,
  'conditionPrompt' | 'providerId' | 'modelId' | 'confirmWithLlm' | 'summarizeWithLlm'
>;
type ScheduleFields = Pick<WatchRuleDraft, 'intervalSeconds' | 'fireMode' | 'cooldownSeconds'>;

function matchFieldsOf(rule: WatchRuleDto): MatchFields {
  return {
    pattern: rule.pattern ?? WATCH_RULE_DRAFT_DEFAULTS.pattern,
    patternFlags: rule.patternFlags ?? WATCH_RULE_DRAFT_DEFAULTS.patternFlags,
    extractGroup: rule.extractGroup ?? WATCH_RULE_DRAFT_DEFAULTS.extractGroup,
    unchangedMinutes: rule.unchangedMinutes ?? WATCH_RULE_DRAFT_DEFAULTS.unchangedMinutes,
    noMatchBehavior: rule.noMatchBehavior ?? WATCH_RULE_DRAFT_DEFAULTS.noMatchBehavior,
  };
}

function llmFieldsOf(rule: WatchRuleDto): LlmFields {
  return {
    conditionPrompt: rule.conditionPrompt ?? WATCH_RULE_DRAFT_DEFAULTS.conditionPrompt,
    providerId: rule.providerId ?? WATCH_RULE_DRAFT_DEFAULTS.providerId,
    modelId: rule.modelId ?? WATCH_RULE_DRAFT_DEFAULTS.modelId,
    confirmWithLlm: rule.confirmWithLlm ?? WATCH_RULE_DRAFT_DEFAULTS.confirmWithLlm,
    summarizeWithLlm: rule.summarizeWithLlm ?? WATCH_RULE_DRAFT_DEFAULTS.summarizeWithLlm,
  };
}

function scheduleFieldsOf(rule: WatchRuleDto): ScheduleFields {
  return {
    intervalSeconds: rule.intervalSeconds ?? WATCH_RULE_DRAFT_DEFAULTS.intervalSeconds,
    fireMode: rule.fireMode ?? WATCH_RULE_DRAFT_DEFAULTS.fireMode,
    cooldownSeconds: rule.cooldownSeconds ?? WATCH_RULE_DRAFT_DEFAULTS.cooldownSeconds,
  };
}

export function createWatchRuleDraft(rule: WatchRuleDto | null): WatchRuleDraft {
  if (!rule) {
    return { ...WATCH_RULE_DRAFT_DEFAULTS };
  }
  return {
    name: rule.name ?? WATCH_RULE_DRAFT_DEFAULTS.name,
    triggerType: rule.triggerType ?? WATCH_RULE_DRAFT_DEFAULTS.triggerType,
    ...matchFieldsOf(rule),
    ...llmFieldsOf(rule),
    ...scheduleFieldsOf(rule),
  };
}

export function applyTriggerType(draft: WatchRuleDraft, next: WatchTriggerType): WatchRuleDraft {
  const nextMin = minIntervalFor(next);
  const intervalSeconds =
    draft.intervalSeconds < nextMin ? (next === 'llm' ? 60 : 30) : draft.intervalSeconds;
  return { ...draft, triggerType: next, intervalSeconds };
}

export function applyProviderId(draft: WatchRuleDraft, next: string | null): WatchRuleDraft {
  return { ...draft, providerId: next, modelId: next === null ? '' : draft.modelId };
}

export function applyAssistResult(
  draft: WatchRuleDraft,
  result: AssistRegexResponse
): WatchRuleDraft {
  return {
    ...draft,
    pattern: result.pattern,
    patternFlags: result.flags,
    extractGroup: result.extractGroup,
  };
}

export function normalizeModelId(providerId: string | null, modelId: string): string | null {
  return providerId ? modelId.trim() || null : null;
}

export function normalizeExtractGroup(raw: string): number {
  return Math.max(0, Number(raw) || 0);
}

export function normalizeUnchangedMinutes(raw: string): number {
  return Math.max(1, Number(raw) || 1);
}

export function normalizeIntervalSeconds(raw: string): number {
  return Number(raw) || 0;
}

export function normalizeCooldownSeconds(raw: string): number {
  return Math.max(0, Number(raw) || 0);
}

export function validateWatchRuleDraft(draft: WatchRuleDraft): WatchRuleValidationError | null {
  if (!draft.name.trim()) {
    return { key: 'watch.validation.nameRequired' };
  }
  if (isRegexTrigger(draft.triggerType)) {
    if (!draft.pattern) {
      return { key: 'watch.validation.patternRequired' };
    }
    try {
      // 与后端 compileWatchPattern 一致：g flag 由服务端自动追加，这里仅验证可编译
      new RegExp(draft.pattern, draft.patternFlags.replace(/g/g, ''));
    } catch (error) {
      return {
        key: 'watch.validation.patternInvalid',
        params: { detail: error instanceof Error ? error.message : String(error) },
      };
    }
    if (
      draft.triggerType === 'unchanged' &&
      (!draft.unchangedMinutes || draft.unchangedMinutes <= 0)
    ) {
      return { key: 'watch.validation.unchangedMinutesInvalid' };
    }
  } else if (!draft.conditionPrompt.trim()) {
    return { key: 'watch.validation.conditionPromptRequired' };
  }
  const minInterval = minIntervalFor(draft.triggerType);
  if (!Number.isInteger(draft.intervalSeconds) || draft.intervalSeconds < minInterval) {
    return { key: 'watch.validation.intervalMin', params: { min: minInterval } };
  }
  return null;
}

export function buildWatchRulePayload(draft: WatchRuleDraft): WatchRulePayload {
  const regexType = isRegexTrigger(draft.triggerType);
  return {
    name: draft.name.trim(),
    triggerType: draft.triggerType,
    pattern: regexType ? draft.pattern : null,
    patternFlags: regexType ? draft.patternFlags : '',
    extractGroup: draft.extractGroup,
    conditionPrompt: draft.triggerType === 'llm' ? draft.conditionPrompt : null,
    providerId: draft.providerId,
    modelId: normalizeModelId(draft.providerId, draft.modelId),
    confirmWithLlm: regexType ? draft.confirmWithLlm : false,
    summarizeWithLlm: regexType ? draft.summarizeWithLlm : false,
    intervalSeconds: draft.intervalSeconds,
    unchangedMinutes: draft.triggerType === 'unchanged' ? draft.unchangedMinutes : null,
    noMatchBehavior: draft.noMatchBehavior,
    fireMode: draft.fireMode,
    cooldownSeconds: draft.cooldownSeconds,
  };
}

export function buildCreateWatchRuleRequest(
  draft: WatchRuleDraft,
  deviceId: string,
  paneId: string
): CreateWatchRuleRequest {
  return { ...buildWatchRulePayload(draft), deviceId, paneId, enabled: true };
}

export function buildUpdateWatchRuleRequest(draft: WatchRuleDraft): UpdateWatchRuleRequest {
  return buildWatchRulePayload(draft);
}

export function buildAssistRegexRequest(
  draft: WatchRuleDraft,
  description: string,
  deviceId: string,
  paneId: string
): AssistRegexRequest {
  return {
    description: description.trim(),
    deviceId,
    paneId,
    providerId: draft.providerId,
    modelId: normalizeModelId(draft.providerId, draft.modelId),
  };
}
