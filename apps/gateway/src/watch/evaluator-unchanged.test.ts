import { describe, expect, test } from 'bun:test';
import { compileWatchPattern, findLastMatch } from './evaluator';
import { evaluateUnchangedRule } from './evaluator-unchanged';
import { makeWatchRule, makeWatchRuleState } from './test-fixtures';

const NOW = new Date('2026-06-13T12:00:00.000Z');

function minutesBefore(minutes: number, base: Date = NOW): string {
  return new Date(base.getTime() - minutes * 60_000).toISOString();
}

const baseRule = makeWatchRule({
  triggerType: 'unchanged',
  pattern: '(\\d+)%',
  extractGroup: 1,
  unchangedMinutes: 10,
});

function lastMatch(screen: string) {
  return findLastMatch(screen, compileWatchPattern('(\\d+)%', ''));
}

describe('evaluateUnchangedRule', () => {
  test('首次观测：记录 lastValue 与计时起点，不 hit', () => {
    const output = evaluateUnchangedRule({
      match: lastMatch('progress 42%\n'),
      rule: baseRule,
      state: null,
      now: NOW,
      canTrigger: true,
    });
    expect(output.hit).toBe(false);
    expect(output.value).toBe('42');
    expect(output.matchedText).toBe('42%');
    expect(output.stateUpdates).toEqual({
      lastValue: '42',
      lastValueChangedAt: NOW.toISOString(),
      triggeredSinceChange: false,
    });
  });

  test('无命中 + reset：清空已有计时', () => {
    const output = evaluateUnchangedRule({
      match: null,
      rule: baseRule,
      state: makeWatchRuleState({
        lastValue: '42',
        lastValueChangedAt: minutesBefore(25),
        triggeredSinceChange: true,
      }),
      now: NOW,
      canTrigger: true,
    });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates).toEqual({
      lastValue: null,
      lastValueChangedAt: null,
      triggeredSinceChange: false,
    });
  });

  test('无命中 + ignore：保持计时不动', () => {
    const output = evaluateUnchangedRule({
      match: null,
      rule: makeWatchRule({ ...baseRule, noMatchBehavior: 'ignore' }),
      state: makeWatchRuleState({ lastValue: '42', lastValueChangedAt: minutesBefore(5) }),
      now: NOW,
      canTrigger: true,
    });
    expect(output.hit).toBe(false);
    expect(output.stateUpdates).toEqual({});
  });

  test('卡住时长刚好等于阈值时 hit', () => {
    const output = evaluateUnchangedRule({
      match: lastMatch('progress 42%\n'),
      rule: baseRule,
      state: makeWatchRuleState({ lastValue: '42', lastValueChangedAt: minutesBefore(10) }),
      now: NOW,
      canTrigger: true,
    });
    expect(output.hit).toBe(true);
    expect(output.stuckMinutes).toBe(10);
    expect(output.value).toBe('42');
  });

  test('卡住已达阈值但 canTrigger 为 false 时不 hit', () => {
    const output = evaluateUnchangedRule({
      match: lastMatch('progress 42%\n'),
      rule: baseRule,
      state: makeWatchRuleState({ lastValue: '42', lastValueChangedAt: minutesBefore(25) }),
      now: NOW,
      canTrigger: false,
    });
    expect(output.hit).toBe(false);
    expect(output.value).toBe('42');
    expect(output.matchedText).toBe('42%');
    expect(output.stateUpdates).toEqual({});
  });

  test('unchangedMinutes 为 0 时即使已卡住也不 hit', () => {
    const output = evaluateUnchangedRule({
      match: lastMatch('progress 42%\n'),
      rule: makeWatchRule({ ...baseRule, unchangedMinutes: 0 }),
      state: makeWatchRuleState({ lastValue: '42', lastValueChangedAt: minutesBefore(40) }),
      now: NOW,
      canTrigger: true,
    });
    expect(output.hit).toBe(false);
    expect(output.value).toBe('42');
  });
});
