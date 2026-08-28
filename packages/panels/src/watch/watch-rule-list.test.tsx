import { beforeAll, describe, expect, test } from 'bun:test';

import { WatchRuleList, type WatchRuleListProps } from './watch-rule-list';
import { makeRule, renderWatch, setupWatchTestEnv } from './watch-test-harness';

beforeAll(setupWatchTestEnv);

function props(overrides: Partial<WatchRuleListProps> = {}): WatchRuleListProps {
  return {
    rules: [],
    status: 'ready',
    showNotifBanner: false,
    onDismissNotifBanner: () => undefined,
    onRetry: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onViewState: () => undefined,
    onDelete: () => undefined,
    onAdd: () => undefined,
    ...overrides,
  };
}

describe('WatchRuleList', () => {
  test('renders an error state with a retry action instead of the empty state', () => {
    const { html } = renderWatch(<WatchRuleList {...props({ status: 'error' })} />);

    expect(html).toContain('data-testid="watch-rules-error"');
    expect(html).toContain('data-testid="watch-rules-retry"');
    expect(html).toContain('Failed to load watch rules');
    expect(html).not.toContain('data-testid="watch-rules-empty"');
  });

  test('renders the empty state only when the query succeeded', () => {
    expect(renderWatch(<WatchRuleList {...props()} />).html).toContain(
      'data-testid="watch-rules-empty"'
    );
    expect(renderWatch(<WatchRuleList {...props({ status: 'loading' })} />).html).not.toContain(
      'data-testid="watch-rules-empty"'
    );
  });

  test('renders one row per rule with its schedule summary', () => {
    const rules = [
      makeRule({ id: 'a', name: 'alpha', intervalSeconds: 15 }),
      makeRule({ id: 'b', name: 'beta', triggerType: 'unchanged', unchangedMinutes: 5 }),
    ];
    const { html } = renderWatch(<WatchRuleList {...props({ rules })} />);

    expect(html).toContain('data-testid="watch-rule-item-a"');
    expect(html).toContain('data-testid="watch-rule-toggle-b"');
    expect(html).toContain('Every 15s');
    expect(html).toContain('Unchanged for 5 min');
  });

  test('rows issue no state request: the list renders zero queries', () => {
    const rules = [makeRule({ id: 'a' }), makeRule({ id: 'b' }), makeRule({ id: 'c' })];
    const { client } = renderWatch(<WatchRuleList {...props({ rules })} />);

    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});
