import { describe, expect, test } from 'bun:test';
import { SAMPLE_RING_LIMIT, WatchSampleStore } from './sample-store';

describe('WatchSampleStore', () => {
  test('returns a copy so callers cannot mutate the ring', () => {
    const store = new WatchSampleStore();
    const at = new Date('2026-06-13T12:00:00.000Z');
    store.push('r1', at, 'ERROR', true);
    const first = store.get('r1');
    first.push({ at: at.toISOString(), value: 'mutated', hit: false });
    expect(store.get('r1')).toEqual([{ at: at.toISOString(), value: 'ERROR', hit: true }]);
  });

  test('unknown rule returns empty array', () => {
    expect(new WatchSampleStore().get('missing')).toEqual([]);
  });

  test('evicts oldest samples past the ring limit', () => {
    const store = new WatchSampleStore();
    const start = new Date('2026-06-13T12:00:00.000Z');
    for (let i = 0; i < SAMPLE_RING_LIMIT + 10; i++) {
      store.push('r1', new Date(start.getTime() + i * 1000), String(i), i % 2 === 0);
    }
    const samples = store.get('r1');
    expect(samples).toHaveLength(SAMPLE_RING_LIMIT);
    expect(samples[0]?.value).toBe('10');
    expect(samples[samples.length - 1]?.value).toBe(String(SAMPLE_RING_LIMIT + 9));
  });

  test('delete and clear drop samples independently per rule', () => {
    const store = new WatchSampleStore();
    const at = new Date('2026-06-13T12:00:00.000Z');
    store.push('r1', at, 'a', false);
    store.push('r2', at, 'b', true);
    store.delete('r1');
    expect(store.get('r1')).toEqual([]);
    expect(store.get('r2')).toHaveLength(1);
    store.clear();
    expect(store.get('r2')).toEqual([]);
  });
});
