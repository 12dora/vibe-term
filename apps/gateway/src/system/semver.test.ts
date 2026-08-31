import { describe, expect, test } from 'bun:test';
import { compareVersions } from './semver';

describe('compareVersions', () => {
  test('compares core major.minor.patch', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.2.2', '1.2.3')).toBe(-1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });

  test('a prerelease is lower than its release', () => {
    expect(compareVersions('1.2.3-beta.10', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.3-beta.10')).toBe(1);
    expect(compareVersions('1.2.3-beta.2', '1.2.3')).toBe(-1);
  });

  test('numeric prerelease identifiers compare numerically', () => {
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.10')).toBe(-1);
    expect(compareVersions('1.2.3-beta.10', '1.2.3-beta.2')).toBe(1);
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.2')).toBe(0);
  });

  test('follows SemVer 2.0 prerelease precedence', () => {
    const chain = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareVersions(chain[i] as string, chain[i + 1] as string)).toBe(-1);
    }
  });

  test('unparseable versions compare as equal', () => {
    expect(compareVersions('unknown', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', 'nope')).toBe(0);
  });
});
