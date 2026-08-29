import type { WatchRuleRecord, WatchRuleStateRecord } from '../db/watch';
import type { WatchEvalOutput } from './evaluator';

function passesTriggerGate(
  rule: WatchRuleRecord,
  state: WatchRuleStateRecord | null,
  now: Date
): boolean {
  if (rule.fireMode === 'once') {
    if (rule.triggerType === 'unchanged') {
      return !state?.triggeredSinceChange;
    }
    return true;
  }

  const lastTriggeredAtMs = state?.lastTriggeredAt ? Date.parse(state.lastTriggeredAt) : Number.NaN;
  if (!Number.isNaN(lastTriggeredAtMs)) {
    const cooldownMs = Math.max(0, rule.cooldownSeconds) * 1000;
    if (now.getTime() - lastTriggeredAtMs < cooldownMs) {
      return false;
    }
  }
  return true;
}

function resetUnchangedStateIfNeeded(
  rule: WatchRuleRecord,
  state: WatchRuleStateRecord | null
): WatchEvalOutput {
  if (
    rule.noMatchBehavior === 'reset' &&
    (state?.lastValue != null || state?.lastValueChangedAt != null || state?.triggeredSinceChange)
  ) {
    return {
      hit: false,
      stateUpdates: { lastValue: null, lastValueChangedAt: null, triggeredSinceChange: false },
    };
  }
  return { hit: false, stateUpdates: {} };
}

function shouldRestartUnchangedTimer(state: WatchRuleStateRecord | null, value: string): boolean {
  const lastValue = state?.lastValue ?? null;
  const lastChangedAtMs = state?.lastValueChangedAt
    ? Date.parse(state.lastValueChangedAt)
    : Number.NaN;
  return lastValue === null || value !== lastValue || Number.isNaN(lastChangedAtMs);
}

export function evaluateMatchTrigger(
  rule: WatchRuleRecord,
  state: WatchRuleStateRecord | null,
  now: Date,
  match: RegExpExecArray | null
): WatchEvalOutput {
  if (!match) {
    return { hit: false, stateUpdates: {} };
  }
  return {
    hit: passesTriggerGate(rule, state, now),
    matchedText: match[0],
    stateUpdates: {},
  };
}

function unchangedHoldResult(
  rule: WatchRuleRecord,
  state: WatchRuleStateRecord | null,
  now: Date,
  match: RegExpExecArray,
  value: string
): WatchEvalOutput {
  const unchangedMinutes = rule.unchangedMinutes ?? 0;
  const lastChangedAtMs = Date.parse(state?.lastValueChangedAt ?? '');
  const elapsedMs = now.getTime() - lastChangedAtMs;
  if (unchangedMinutes <= 0 || elapsedMs < unchangedMinutes * 60_000) {
    return { hit: false, value, matchedText: match[0], stateUpdates: {} };
  }
  if (!passesTriggerGate(rule, state, now)) {
    return { hit: false, value, matchedText: match[0], stateUpdates: {} };
  }
  return {
    hit: true,
    value,
    matchedText: match[0],
    stuckMinutes: Math.floor(elapsedMs / 60_000),
    stateUpdates: {},
  };
}

export function evaluateUnchangedTrigger(
  rule: WatchRuleRecord,
  state: WatchRuleStateRecord | null,
  now: Date,
  match: RegExpExecArray | null
): WatchEvalOutput {
  const extractGroup = Math.max(0, rule.extractGroup ?? 0);
  const value = match?.[extractGroup];

  if (!match || value === undefined) {
    return resetUnchangedStateIfNeeded(rule, state);
  }

  if (shouldRestartUnchangedTimer(state, value)) {
    return {
      hit: false,
      value,
      matchedText: match[0],
      stateUpdates: {
        lastValue: value,
        lastValueChangedAt: now.toISOString(),
        triggeredSinceChange: false,
      },
    };
  }

  return unchangedHoldResult(rule, state, now, match, value);
}
