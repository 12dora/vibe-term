// Watch 规则契约

export type WatchTriggerType = 'match' | 'unchanged' | 'llm';

export type WatchNoMatchBehavior = 'reset' | 'ignore';

export type WatchFireMode = 'once' | 'repeat';

export interface WatchRuleDto {
  id: string;
  name: string;
  deviceId: string;
  paneId: string;
  enabled: boolean;
  triggerType: WatchTriggerType;
  pattern: string | null;
  patternFlags: string;
  extractGroup: number;
  conditionPrompt: string | null;
  providerId: string | null;
  modelId: string | null;
  confirmWithLlm: boolean;
  summarizeWithLlm: boolean;
  intervalSeconds: number;
  unchangedMinutes: number | null;
  noMatchBehavior: WatchNoMatchBehavior;
  fireMode: WatchFireMode;
  cooldownSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface WatchRuleStateDto {
  ruleId: string;
  lastSampledAt: string | null;
  lastValue: string | null;
  lastValueChangedAt: string | null;
  triggeredSinceChange: boolean;
  lastTriggeredAt: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  modelUnavailableNotified: boolean;
}

/** 内存 ring buffer 中的近期采样点（不持久化） */
export interface WatchRuleSampleDto {
  at: string;
  value: string | null;
  hit: boolean;
}

export interface ListWatchRulesResponse {
  rules: WatchRuleDto[];
}

export interface CreateWatchRuleRequest {
  name: string;
  deviceId: string;
  paneId: string;
  enabled?: boolean;
  triggerType: WatchTriggerType;
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

export interface UpdateWatchRuleRequest {
  name?: string;
  paneId?: string;
  enabled?: boolean;
  triggerType?: WatchTriggerType;
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

export interface WatchRuleResponse {
  rule: WatchRuleDto;
  state: WatchRuleStateDto | null;
}

export interface WatchRuleStateResponse {
  state: WatchRuleStateDto | null;
  samples: WatchRuleSampleDto[];
}

export interface AssistRegexRequest {
  description: string;
  deviceId?: string;
  paneId?: string;
  providerId?: string | null;
  modelId?: string | null;
}

export interface AssistRegexResponse {
  pattern: string;
  flags: string;
  extractGroup: number;
  explanation: string;
  /** 在屏幕样本上的试跑命中（无屏幕上下文时为空数组） */
  preview: string[];
}
