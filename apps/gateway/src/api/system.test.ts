import { describe, expect, test } from 'bun:test';
import { handleSystemApiRequest, isReleaseVersion } from './system';

describe('isReleaseVersion', () => {
  test('accepts strict semver with optional prerelease', () => {
    expect(isReleaseVersion('1.2.3')).toBe(true);
    expect(isReleaseVersion('1.2.3-beta.1')).toBe(true);
    expect(isReleaseVersion('0.11.0')).toBe(true);
  });

  test('rejects latest, traversal, and non-semver strings', () => {
    expect(isReleaseVersion('latest')).toBe(false);
    expect(isReleaseVersion('../etc/passwd')).toBe(false);
    expect(isReleaseVersion('1.2')).toBe(false);
    expect(isReleaseVersion('1.2.3+build')).toBe(false);
    expect(isReleaseVersion('v1.2.3')).toBe(false);
    expect(isReleaseVersion('')).toBe(false);
  });
});

describe('POST /api/system/upgrade version validation', () => {
  test('rejects missing, latest, and non-semver versions with 400', async () => {
    for (const body of [{}, { version: '' }, { version: 'latest' }, { version: '../etc' }]) {
      const response = await handleSystemApiRequest(
        new Request('http://localhost/api/system/upgrade', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        '/api/system/upgrade'
      );
      expect(response?.status).toBe(400);
    }
  });

  test('does not start upgrade for an invalid version', async () => {
    const response = await handleSystemApiRequest(
      new Request('http://localhost/api/system/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: '1.2.3/../../../tmp' }),
      }),
      '/api/system/upgrade'
    );
    expect(response?.status).toBe(400);
    const payload = (await response?.json()) as { error?: string };
    expect(payload.error).toBeTruthy();
  });
});
