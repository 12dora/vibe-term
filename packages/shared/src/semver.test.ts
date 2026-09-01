import { describe, expect, test } from 'bun:test';
import { compareSemver, parseSemver } from './semver';

describe('parseSemver', () => {
  test('解析 X.Y.Z 与 prerelease', () => {
    expect(parseSemver('1.1.7')).toEqual({ major: 1, minor: 1, patch: 7, prerelease: null });
    expect(parseSemver(' 2.0.0 ')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: null });
    expect(parseSemver('1.2.3-beta.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'beta.1',
    });
  });

  test('非严格 semver 返回 null', () => {
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('dev')).toBeNull();
    expect(parseSemver('1.1')).toBeNull();
    expect(parseSemver('v1.1.7')).toBeNull();
    // 开发态网关自报形如 1.1.9_dev，下划线后缀不是合法 prerelease
    expect(parseSemver('1.1.9_dev')).toBeNull();
  });
});

describe('compareSemver', () => {
  test('按 major/minor/patch 排序', () => {
    expect(compareSemver('1.1.7', '1.1.7')).toBe(0);
    expect(compareSemver('1.1.8', '1.1.7')).toBe(1);
    expect(compareSemver('1.1.6', '1.1.7')).toBe(-1);
    expect(compareSemver('1.2.0', '1.1.7')).toBe(1);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
  });

  test('prerelease 低于正式版且按标识符逐段比较', () => {
    expect(compareSemver('1.1.7-beta.1', '1.1.7')).toBe(-1);
    expect(compareSemver('1.1.7', '1.1.7-beta.1')).toBe(1);
    expect(compareSemver('1.1.7-beta.2', '1.1.7-beta.10')).toBe(-1);
    expect(compareSemver('1.1.7-beta.10', '1.1.7-beta.2')).toBe(1);
    expect(compareSemver('1.1.7-alpha', '1.1.7-beta')).toBe(-1);
    expect(compareSemver('1.1.7-beta', '1.1.7-beta.1')).toBe(-1);
    expect(compareSemver('1.1.7-beta.1', '1.1.7-beta.1')).toBe(0);
  });

  test('任一侧无法解析返回 null', () => {
    expect(compareSemver('1.1.9_dev', '1.1.7')).toBeNull();
    expect(compareSemver('dev', '1.1.7')).toBeNull();
    expect(compareSemver('', '1.1.7')).toBeNull();
    expect(compareSemver('1.1.7', 'unknown')).toBeNull();
  });
});
