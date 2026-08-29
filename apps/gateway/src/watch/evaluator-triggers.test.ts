import { describe, expect, test } from 'bun:test';
import { compileWatchPattern, findLastMatch } from './evaluator';
import { evaluateMatchTrigger, evaluateUnchangedTrigger } from './evaluator-triggers';
import { makeWatchRule, makeWatchRuleState } from './test-fixtures';

const NOW = new Date('2026-06-13T12:00:00.000Z');

function minutesBefore(minutes: number, base: Date = NOW): string {
  return new Date(base.getTime() - minutes * 60_000).toISOString();
}

function lastMatch(screen: string, pattern: string, flags = ''): RegExpExecArray | null {
  return findLastMatch(screen, compileWatchPattern(pattern, flags));
}

describe('evaluateMatchTrigger', () => {
  test('no match does not hit', () => {
    const output = evaluateMatchTrigger(
      makeWatchRule({ triggerType: 'match', pattern: 'ERROR' }),
      null,
      NOW,
      null
    );
    expect(output).toEqual({ hit: false, stateUpdates: {} });
  });

  test('match hits with last matched text', () => {
    const match = lastMatch('ERROR: first\nERROR: second\n', 'ERROR: (\\w+)');
    const output = evaluateMatchTrigger(
      makeWatchRule({ triggerType: 'match', pattern: 'ERROR: (\\w+)' }),
      null,
      NOW,
      match
    );
    expect(output.hit).toBe(true);
    expect(output.matchedText).toBe('ERROR: second');
    expect(output.stateUpdates).toEqual({});
  });

  test('repeat cooldown blocks then allows hit', () => {
    const rule = makeWatchRule({
      triggerType: 'match',
      pattern: 'ERROR',
      fireMode: 'repeat',
      cooldownSeconds: 600,
    });
    const match = lastMatch('ERROR\n', 'ERROR');

    expect(
      evaluateMatchTrigger(
        rule,
        makeWatchRuleState({ lastTriggeredAt: minutesBefore(5) }),
        NOW,
        match
      ).hit
    ).toBe(false);
    expect(
      evaluateMatchTrigger(
        rule,
        makeWatchRuleState({ lastTriggeredAt: minutesBefore(11) }),
        NOW,
        match
      ).hit
    ).toBe(true);
  });
});

describe('evaluateUnchangedTrigger', () => {
  const rule = makeWatchRule({
    triggerType: 'unchanged',
    pattern: '(\\d+)%',
    extractGroup: 1,
    unchangedMinutes: 10,
  });

  test('missing group follows reset/ignore no-match rules', () => {
    const optionalGroup = makeWatchRule({
      triggerType: 'unchanged',
      pattern: 'progress (\\d+)?',
      extractGroup: 1,
      unchangedMinutes: 10,
      noMatchBehavior: 'ignore',
    });
    const match = lastMatch('progress \n', 'progress (\\d+)?');
    const output = evaluateUnchangedTrigger(optionalGroup, null, NOW, match);
    expect(output.hit).toBe(false);
    expect(output.value).toBeUndefined();
    expect(output.stateUpdates).toEqual({});
  });

  test('no match reset clears tracking when state is present', () => {
    const state = makeWatchRuleState({
      lastValue: '42',
      lastValueChangedAt: minutesBefore(25),
      triggeredSinceChange: true,
    });
    const output = evaluateUnchangedTrigger(rule, state, NOW, null);
    expect(output).toEqual({
      hit: false,
      stateUpdates: { lastValue: null, lastValueChangedAt: null, triggeredSinceChange: false },
    });
  });

  test('no match reset is a no-op when state is empty', () => {
    expect(evaluateUnchangedTrigger(rule, null, NOW, null)).toEqual({
      hit: false,
      stateUpdates: {},
    });
  });

  test('no match ignore keeps tracking', () => {
    const ignoreRule = makeWatchRule({ ...rule, noMatchBehavior: 'ignore' });
    const state = makeWatchRuleState({ lastValue: '42', lastValueChangedAt: minutesBefore(5) });
    expect(evaluateUnchangedTrigger(ignoreRule, state, NOW, null)).toEqual({
      hit: false,
      stateUpdates: {},
    });
  });

  test('first value records tracking without hitting', () => {
    const match = lastMatch('progress 42%\n', '(\\d+)%');
    const output = evaluateUnchangedTrigger(rule, null, NOW, match);
    expect(output.hit).toBe(false);
    expect(output.value).toBe('42');
    expect(output.stateUpdates).toEqual({
      lastValue: '42',
      lastValueChangedAt: NOW.toISOString(),
      triggeredSinceChange: false,
    });
  });

  test('unchanged past threshold hits with stuckMinutes', () => {
    const match = lastMatch('progress 42%\n', '(\\d+)%');
    const state = makeWatchRuleState({ lastValue: '42', lastValueChangedAt: minutesBefore(25) });
    const output = evaluateUnchangedTrigger(rule, state, NOW, match);
    expect(output.hit).toBe(true);
    expect(output.stuckMinutes).toBe(25);
    expect(output.stateUpdates).toEqual({});
  });

  test('once does not re-hit after triggeredSinceChange', () => {
    const match = lastMatch('progress 42%\n', '(\\d+)%');
    const state = makeWatchRuleState({
      lastValue: '42',
      lastValueChangedAt: minutesBefore(25),
      triggeredSinceChange: true,
    });
    expect(evaluateUnchangedTrigger(rule, state, NOW, match).hit).toBe(false);
  });
});
