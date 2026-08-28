import { describe, expect, test } from 'bun:test';
import { compileWatchPattern, findLastMatch } from './evaluator';
import { evaluateMatchRule } from './evaluator-match';

describe('evaluateMatchRule', () => {
  test('无命中不 hit', () => {
    expect(evaluateMatchRule(null, true)).toEqual({ hit: false, stateUpdates: {} });
  });

  test('命中且 canTrigger 时 hit，matchedText 取整段匹配', () => {
    const match = findLastMatch(
      'ERROR: first\nERROR: last',
      compileWatchPattern('ERROR: \\w+', '')
    );
    const output = evaluateMatchRule(match, true);
    expect(output.hit).toBe(true);
    expect(output.matchedText).toBe('ERROR: last');
    expect(output.stateUpdates).toEqual({});
  });

  test('命中但 canTrigger 为 false 时不 hit（cooldown / once 闸门）', () => {
    const match = findLastMatch('ERROR', compileWatchPattern('ERROR', ''));
    const output = evaluateMatchRule(match, false);
    expect(output.hit).toBe(false);
    expect(output.matchedText).toBe('ERROR');
    expect(output.stateUpdates).toEqual({});
  });
});
