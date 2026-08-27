import { describe, expect, test } from 'bun:test';
import { t } from '../i18n';
import { buildTriggerMessage } from './notifier';
import { makeWatchRule } from './test-fixtures';

describe('buildTriggerMessage', () => {
  test('match / unchanged / llm / summary 分支与未经确认后缀', () => {
    const match = buildTriggerMessage(
      makeWatchRule({ name: 'build' }),
      { hit: true, matchedText: 'FAILED', stateUpdates: {} },
      null,
      false
    );
    expect(match).toBe(t('notification.watch.matchTriggered', { name: 'build', text: 'FAILED' }));

    const unchanged = buildTriggerMessage(
      makeWatchRule({ name: 'build', triggerType: 'unchanged' }),
      { hit: true, value: '73', stuckMinutes: 11, stateUpdates: {} },
      null,
      false
    );
    expect(unchanged).toBe(
      t('notification.watch.unchangedTriggered', { name: 'build', value: '73', minutes: 11 })
    );

    const llm = buildTriggerMessage(
      makeWatchRule({ name: 'build', triggerType: 'llm' }),
      { hit: true, stateUpdates: {} },
      null,
      false,
      'compile finished'
    );
    expect(llm).toBe(
      t('notification.watch.llmTriggered', { name: 'build', reason: 'compile finished' })
    );

    const summary = buildTriggerMessage(
      makeWatchRule({ name: 'build' }),
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
