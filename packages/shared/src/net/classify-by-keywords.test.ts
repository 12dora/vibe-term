import { describe, expect, test } from 'bun:test';
import { type KeywordRule, classifyByKeywords, truncateReason } from './classify-by-keywords';

const RULES: ReadonlyArray<KeywordRule<string | null>> = [
  [['skip me'], null],
  [['timeout', 'timed out'], 'timeout'],
  [['ice'], 'ice'],
];

describe('classifyByKeywords', () => {
  test('matches case-insensitively on the first rule that hits', () => {
    expect(classifyByKeywords('Dial TIMED OUT', RULES, () => 'other')).toBe('timeout');
    expect(classifyByKeywords('ice failed', RULES, () => 'other')).toBe('ice');
  });

  test('rule order is priority', () => {
    expect(classifyByKeywords('ice timeout', RULES, () => 'other')).toBe('timeout');
  });

  test('a rule may map to null', () => {
    expect(classifyByKeywords('please skip me', RULES, () => 'other')).toBeNull();
  });

  test('fallback receives the lowercased reason', () => {
    expect(classifyByKeywords('Weird Reason', RULES, (normalized) => normalized)).toBe(
      'weird reason'
    );
  });

  test('empty keyword lists never match', () => {
    expect(classifyByKeywords('anything', [[[], 'never']], () => 'other')).toBe('other');
  });
});

describe('truncateReason', () => {
  test('keeps short reasons and cuts long ones', () => {
    expect(truncateReason('short')).toBe('short');
    expect(truncateReason('x'.repeat(80))).toHaveLength(64);
    expect(truncateReason('abcdef', 3)).toBe('abc');
  });
});
