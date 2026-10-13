import { describe, expect, test } from 'bun:test';
import { resolveNavDirection } from './use-tab-navigation';

describe('resolveNavDirection', () => {
  test('no recorded navigation means no animation direction', () => {
    expect(resolveNavDirection(null, '/srv/data')).toBe('none');
  });

  test('uses the recorded direction while the tab is still at that path', () => {
    expect(resolveNavDirection({ direction: 'forward', path: '/srv/data/a' }, '/srv/data/a')).toBe(
      'forward'
    );
    expect(resolveNavDirection({ direction: 'up', path: '/srv' }, '/srv')).toBe('up');
  });

  test('a path changed from elsewhere invalidates the direction', () => {
    expect(resolveNavDirection({ direction: 'back', path: '/srv/data' }, '/srv/renamed')).toBe(
      'none'
    );
  });
});
