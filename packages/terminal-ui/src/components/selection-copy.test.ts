import { describe, expect, test } from 'bun:test';
import { nextAutoCopyText, planCopySelection } from './selection-copy';

describe('planCopySelection', () => {
  test('空选区走失败，有文本才写入', () => {
    expect(planCopySelection('')).toBe('empty');
    expect(planCopySelection('ls -la')).toBe('write');
  });
});

describe('nextAutoCopyText', () => {
  test('同一段文本不重复复制，选区变化或清空后可再复制', () => {
    expect(nextAutoCopyText('', null)).toBeNull();
    expect(nextAutoCopyText('foo', null)).toBe('foo');
    expect(nextAutoCopyText('foo', 'foo')).toBeNull();
    expect(nextAutoCopyText('foobar', 'foo')).toBe('foobar');
  });
});
