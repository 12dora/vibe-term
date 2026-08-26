import { describe, expect, test } from 'bun:test';
import type { WatchRuleRecord } from '../db/watch';
import { t } from '../i18n';
import { buildTriggerMessage } from './notifier';

const NOW = new Date('2026-06-13T12:00:00.000Z');

function makeRule(overrides: Partial<WatchRuleRecord> = {}): WatchRuleRecord {
  return {
    id: 'rule-1',
    name: 'build',
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

describe('buildTriggerMessage', () => {
  test('match / unchanged / llm / summary 分支与未经确认后缀', () => {
    const match = buildTriggerMessage(
      makeRule(),
      { hit: true, matchedText: 'FAILED', stateUpdates: {} },
      null,
      false
    );
    expect(match).toBe(t('notification.watch.matchTriggered', { name: 'build', text: 'FAILED' }));

    const unchanged = buildTriggerMessage(
      makeRule({ triggerType: 'unchanged' }),
      { hit: true, value: '73', stuckMinutes: 11, stateUpdates: {} },
      null,
      false
    );
    expect(unchanged).toBe(
      t('notification.watch.unchangedTriggered', { name: 'build', value: '73', minutes: 11 })
    );

    const llm = buildTriggerMessage(
      makeRule({ triggerType: 'llm' }),
      { hit: true, stateUpdates: {} },
      null,
      false,
      'compile finished'
    );
    expect(llm).toBe(
      t('notification.watch.llmTriggered', { name: 'build', reason: 'compile finished' })
    );

    const summary = buildTriggerMessage(
      makeRule(),
      { hit: true, matchedText: 'FAILED', stateUpdates: {} },
      'wget stalled',
      true
    );
    expect(summary).toBe(
      t('notification.watch.summaryTriggered', { name: 'build', summary: 'wget stalled' }) +
        t('notification.watch.unconfirmedSuffix')
    );
  });
});
