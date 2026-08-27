import { describe, expect, test } from 'bun:test';
import {
  SCREEN_PROMPT_CHAR_LIMIT,
  buildConfirmPrompt,
  buildJudgePrompt,
  buildSummaryPrompt,
  passesLlmCooldownGate,
  truncateScreen,
} from './evaluation-pipeline';
import { makeWatchRule, makeWatchRuleState } from './test-fixtures';

const NOW = new Date('2026-06-13T12:00:00.000Z');

describe('truncateScreen / screenBlock', () => {
  test('keeps short screens intact and trims to the tail of long ones', () => {
    expect(truncateScreen('abc')).toBe('abc');
    const long = 'x'.repeat(SCREEN_PROMPT_CHAR_LIMIT + 20);
    const truncated = truncateScreen(long);
    expect(truncated).toHaveLength(SCREEN_PROMPT_CHAR_LIMIT);
    expect(truncated).toBe(long.slice(-SCREEN_PROMPT_CHAR_LIMIT));
  });

  test('prompts wrap untrusted screen data in markers', () => {
    const rule = makeWatchRule({ conditionPrompt: 'did it finish?' });
    const confirm = buildConfirmPrompt(
      rule,
      { hit: true, matchedText: 'ERROR', stateUpdates: {} },
      'screen'
    );
    expect(confirm).toContain('<<<SCREEN>>>');
    expect(confirm).toContain('<<<END_SCREEN>>>');
    expect(confirm).toContain('untrusted data');
    expect(confirm).toContain('ERROR');

    const summary = buildSummaryPrompt(
      rule,
      { hit: true, matchedText: 'ERROR', stuckMinutes: 3, stateUpdates: {} },
      'screen'
    );
    expect(summary).toContain('Value unchanged for 3 minutes.');

    const judge = buildJudgePrompt(rule, 'screen');
    expect(judge).toContain('did it finish?');
  });
});

describe('passesLlmCooldownGate', () => {
  test('once 始终放行；repeat 受 cooldown 约束', () => {
    expect(
      passesLlmCooldownGate(
        makeWatchRule({ fireMode: 'once', cooldownSeconds: 600 }),
        makeWatchRuleState(),
        NOW
      )
    ).toBe(true);

    const inCooldown = passesLlmCooldownGate(
      makeWatchRule({ fireMode: 'repeat', cooldownSeconds: 600 }),
      makeWatchRuleState({ lastTriggeredAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() }),
      NOW
    );
    expect(inCooldown).toBe(false);

    const afterCooldown = passesLlmCooldownGate(
      makeWatchRule({ fireMode: 'repeat', cooldownSeconds: 600 }),
      makeWatchRuleState({ lastTriggeredAt: new Date(NOW.getTime() - 11 * 60_000).toISOString() }),
      NOW
    );
    expect(afterCooldown).toBe(true);
  });
});
