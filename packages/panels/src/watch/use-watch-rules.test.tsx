import { beforeAll, describe, expect, test } from 'bun:test';

import { resolveQueryStatus, useWatchRules } from './use-watch-rules';
import { renderWatch, setupWatchTestEnv } from './watch-test-harness';

beforeAll(setupWatchTestEnv);

describe('resolveQueryStatus', () => {
  test('reports error when the query failed without data', () => {
    expect(resolveQueryStatus({ isLoading: false, isError: true, hasData: false })).toBe('error');
  });

  test('keeps rendering data when a background refetch fails', () => {
    expect(resolveQueryStatus({ isLoading: false, isError: true, hasData: true })).toBe('ready');
  });

  test('reports loading only for the first fetch', () => {
    expect(resolveQueryStatus({ isLoading: true, isError: false, hasData: false })).toBe('loading');
    expect(resolveQueryStatus({ isLoading: false, isError: false, hasData: true })).toBe('ready');
  });
});

function RulesProbe() {
  const { status, rules } = useWatchRules('d1', '%1', true);
  return <span data-testid="probe">{`${status}:${rules.length}`}</span>;
}

describe('useWatchRules', () => {
  test('registers a single rules query for the whole list', () => {
    const { html, client } = renderWatch(<RulesProbe />);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);

    expect(keys).toEqual([['watch-rules', 'd1', '%1']]);
    expect(html).toContain('loading:0');
  });
});
