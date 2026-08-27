import type { WatchRuleRecord, WatchRuleStateRecord } from '../db/watch';

const NOW = new Date('2026-06-13T12:00:00.000Z');

export function makeWatchRule(overrides: Partial<WatchRuleRecord> = {}): WatchRuleRecord {
  return {
    id: 'rule-1',
    name: 'test rule',
    deviceId: 'device-1',
    paneId: '%1',
    enabled: true,
    triggerType: 'match',
    pattern: 'ERROR',
    patternFlags: '',
    extractGroup: 0,
    conditionPrompt: null,
    providerId: null,
    modelId: null,
    confirmWithLlm: false,
    summarizeWithLlm: false,
    intervalSeconds: 30,
    unchangedMinutes: null,
    noMatchBehavior: 'reset',
    fireMode: 'once',
    cooldownSeconds: 600,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

export function makeWatchRuleState(
  overrides: Partial<WatchRuleStateRecord> = {}
): WatchRuleStateRecord {
  return {
    ruleId: 'rule-1',
    lastSampledAt: null,
    lastValue: null,
    lastValueChangedAt: null,
    triggeredSinceChange: false,
    lastTriggeredAt: null,
    consecutiveErrors: 0,
    lastError: null,
    modelUnavailableNotified: false,
    ...overrides,
  };
}
