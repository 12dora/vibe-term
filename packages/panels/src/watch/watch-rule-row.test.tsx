import { describe, expect, test } from 'bun:test';

import { formatRuleSchedule } from './watch-rule-row';
import { makeRule } from './watch-test-harness';

const translate = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.values(params).join(',')})` : key;

describe('formatRuleSchedule', () => {
  test('shows the sampling interval for match rules', () => {
    expect(formatRuleSchedule(makeRule({ intervalSeconds: 20 }), translate)).toBe(
      'watch.rules.everySeconds(20)'
    );
  });

  test('prefixes the unchanged window for unchanged rules', () => {
    const rule = makeRule({ triggerType: 'unchanged', unchangedMinutes: 5, intervalSeconds: 30 });

    expect(formatRuleSchedule(rule, translate)).toBe(
      'watch.rules.unchangedFor(5) · watch.rules.everySeconds(30)'
    );
  });

  test('falls back to the interval when the unchanged window is missing', () => {
    const rule = makeRule({ triggerType: 'unchanged', unchangedMinutes: null });

    expect(formatRuleSchedule(rule, translate)).toBe('watch.rules.everySeconds(30)');
  });
});
