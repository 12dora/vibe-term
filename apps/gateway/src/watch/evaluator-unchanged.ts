import type { WatchRuleRecord, WatchRuleStateRecord } from '../db/watch';
import type { WatchEvalOutput } from './evaluator';

export interface EvaluateUnchangedInput {
  match: RegExpExecArray | null;
  rule: WatchRuleRecord;
  state: WatchRuleStateRecord | null;
  now: Date;
  canTrigger: boolean;
}

function hasTimingState(state: WatchRuleStateRecord | null): boolean {
  return (
    state?.lastValue != null ||
    state?.lastValueChangedAt != null ||
    Boolean(state?.triggeredSinceChange)
  );
}

function handleNoMatch(rule: WatchRuleRecord, state: WatchRuleStateRecord | null): WatchEvalOutput {
  if (rule.noMatchBehavior === 'reset' && hasTimingState(state)) {
    return {
      hit: false,
      stateUpdates: { lastValue: null, lastValueChangedAt: null, triggeredSinceChange: false },
    };
  }
  return { hit: false, stateUpdates: {} };
}

function recordObservedValue(value: string, matchedText: string, now: Date): WatchEvalOutput {
  return {
    hit: false,
    value,
    matchedText,
    stateUpdates: {
      lastValue: value,
      lastValueChangedAt: now.toISOString(),
      triggeredSinceChange: false,
    },
  };
}

function unchangedMiss(value: string, matchedText: string): WatchEvalOutput {
  return { hit: false, value, matchedText, stateUpdates: {} };
}

function extractCapturedValue(
  match: RegExpExecArray | null,
  rule: WatchRuleRecord
): string | undefined {
  const extractGroup = Math.max(0, rule.extractGroup ?? 0);
  return match?.[extractGroup];
}

function parseLastChangedAtMs(state: WatchRuleStateRecord | null): number {
  return state?.lastValueChangedAt ? Date.parse(state.lastValueChangedAt) : Number.NaN;
}

function shouldResetTiming(state: WatchRuleStateRecord | null, value: string): boolean {
  const lastValue = state?.lastValue ?? null;
  if (lastValue === null || value !== lastValue) {
    return true;
  }
  return Number.isNaN(parseLastChangedAtMs(state));
}

function isBelowUnchangedThreshold(rule: WatchRuleRecord, elapsedMs: number): boolean {
  const unchangedMinutes = rule.unchangedMinutes ?? 0;
  return unchangedMinutes <= 0 || elapsedMs < unchangedMinutes * 60_000;
}

/** unchanged 型：无命中 reset/ignore；值变化重置计时；卡住达阈值后由 canTrigger 决定是否 hit。 */
export function evaluateUnchangedRule(input: EvaluateUnchangedInput): WatchEvalOutput {
  const { match, rule, state, now, canTrigger } = input;
  const value = extractCapturedValue(match, rule);

  if (!match || value === undefined) {
    return handleNoMatch(rule, state);
  }

  if (shouldResetTiming(state, value)) {
    return recordObservedValue(value, match[0], now);
  }

  const elapsedMs = now.getTime() - parseLastChangedAtMs(state);
  if (isBelowUnchangedThreshold(rule, elapsedMs) || !canTrigger) {
    return unchangedMiss(value, match[0]);
  }

  return {
    hit: true,
    value,
    matchedText: match[0],
    stuckMinutes: Math.floor(elapsedMs / 60_000),
    stateUpdates: {},
  };
}
