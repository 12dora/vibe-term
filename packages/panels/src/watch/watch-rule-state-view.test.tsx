import { beforeAll, describe, expect, test } from 'bun:test';

import type { WatchRuleStateDto } from '@tmex/shared';
import type { WatchQueryStatus } from './use-watch-rules';
import {
  WatchRuleStatePanel,
  type WatchRuleStatePanelProps,
  WatchRuleStateView,
  buildWatchStateFields,
} from './watch-rule-state-view';
import { makeRule, renderWatch, setupWatchTestEnv } from './watch-test-harness';

beforeAll(setupWatchTestEnv);

const translate = (key: string) => key;

function stateDto(overrides: Partial<WatchRuleStateDto> = {}): WatchRuleStateDto {
  return {
    ruleId: 'r1',
    lastSampledAt: '2026-08-01T10:00:00.000Z',
    lastValue: '42%',
    lastValueChangedAt: null,
    triggeredSinceChange: false,
    lastTriggeredAt: null,
    consecutiveErrors: 3,
    lastError: 'boom',
    modelUnavailableNotified: false,
    ...overrides,
  };
}

describe('buildWatchStateFields', () => {
  test('falls back to the placeholder for every missing field', () => {
    const fields = buildWatchStateFields(null, translate, 'en_US');

    expect(fields).toHaveLength(6);
    expect(fields.every((field) => field.value === 'watch.state.none')).toBe(true);
  });

  test('renders present values and keeps zero-ish values distinguishable', () => {
    const fields = buildWatchStateFields(stateDto(), translate, 'en_US');
    const byLabel = new Map(fields.map((field) => [field.label, field.value]));

    expect(byLabel.get('watch.state.lastValue')).toBe('42%');
    expect(byLabel.get('watch.state.consecutiveErrors')).toBe('3');
    expect(byLabel.get('watch.state.lastError')).toBe('boom');
    expect(byLabel.get('watch.state.lastTriggeredAt')).toBe('watch.state.none');
  });
});

describe('WatchRuleStatePanel', () => {
  function panelProps(status: WatchQueryStatus): WatchRuleStatePanelProps {
    return {
      rule: makeRule(),
      status,
      state: null,
      samples: [],
      onBack: () => undefined,
      onRetry: () => undefined,
    };
  }

  test('renders an error state with retry instead of all-placeholder fields', () => {
    const { html } = renderWatch(<WatchRuleStatePanel {...panelProps('error')} />);

    expect(html).toContain('data-testid="watch-rule-state-error"');
    expect(html).toContain('data-testid="watch-rule-state-retry"');
    expect(html).toContain('Failed to load rule status');
    expect(html).not.toContain('Recent samples');
  });

  test('renders the fields only once the query succeeded', () => {
    expect(renderWatch(<WatchRuleStatePanel {...panelProps('ready')} />).html).toContain(
      'Recent samples'
    );
    expect(renderWatch(<WatchRuleStatePanel {...panelProps('loading')} />).html).not.toContain(
      'Recent samples'
    );
  });
});

describe('WatchRuleStateView', () => {
  test('requests the rule state exactly once, only in the detail view', () => {
    const { client } = renderWatch(
      <WatchRuleStateView rule={makeRule({ id: 'a' })} onBack={() => undefined} />
    );
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);

    expect(keys).toEqual([['watch-rule-state', 'a']]);
  });
});
