import { describe, expect, test } from 'bun:test';
import {
  RELEASE_LATEST_URL,
  legacyReleaseTarballName,
  releaseChangelogUrl,
  releaseSumsUrl,
} from '@vibeterm/shared';
import {
  LAST_MODIFIED_ISO,
  type Route,
  captures,
  hits,
  mockRoutes,
  redirectTo,
  releaseRoutes,
  sumsBody,
  sumsRoute,
  tagLocation,
  text,
  useReleaseTestEnv,
} from '../test-support/release-routes';
import {
  ReleaseNotFoundError,
  ReleaseUnavailableError,
  checkForUpdate,
  fetchLatestGithubRelease,
  requireLatestUpgradeRelease,
  requirePublishedUpgradeRelease,
} from './update-check';
import { getBaseVersion } from './version';

useReleaseTestEnv();

describe('checkForUpdate', () => {
  test('newer release with tarball → hasUpdate true, changelog and publishedAt from last-modified', async () => {
    const current = getBaseVersion();
    expect(current).not.toBe('unknown');
    const changelog = '## 99.0.0\n\n- notes';
    mockRoutes(releaseRoutes('99.0.0', changelog));

    const result = await checkForUpdate();

    expect(result).toEqual({
      currentVersion: current,
      latestVersion: '99.0.0',
      hasUpdate: true,
      changelog,
      publishedAt: LAST_MODIFIED_ISO,
    });
  });

  test('never touches the GitHub REST API host; latest uses redirect:manual and sends a vibeterm User-Agent', async () => {
    mockRoutes(releaseRoutes('99.0.0'));
    await checkForUpdate();

    expect(captures.map((c) => c.url).sort()).toEqual(
      [RELEASE_LATEST_URL, releaseSumsUrl('99.0.0'), releaseChangelogUrl('99.0.0')].sort()
    );
    expect(captures.some((c) => new URL(c.url).hostname.startsWith('api.'))).toBe(false);
    const latest = captures.find((c) => c.url === RELEASE_LATEST_URL);
    expect(latest?.redirect).toBe('manual');
    expect(captures.every((c) => c.userAgent === `vibeterm/${getBaseVersion()}`)).toBe(true);
    expect(captures.every((c) => c.hasSignal)).toBe(true);
  });

  test('same version → hasUpdate false', async () => {
    const current = getBaseVersion();
    mockRoutes(releaseRoutes(current, 'same'));

    const result = await checkForUpdate();
    expect(result.latestVersion).toBe(current);
    expect(result.hasUpdate).toBe(false);
    expect(result.changelog).toBe('same');
  });

  test('SHA256SUMS without a tarball → hasUpdate false, latestVersion still reported', async () => {
    mockRoutes({
      ...releaseRoutes('99.0.0'),
      [releaseSumsUrl('99.0.0')]: sumsRoute('99.0.0', ['install.sh']),
    });

    const result = await checkForUpdate();
    expect(result.latestVersion).toBe('99.0.0');
    expect(result.hasUpdate).toBe(false);
  });

  test('legacy-name-only SHA256SUMS still counts as a tarball', async () => {
    mockRoutes({
      ...releaseRoutes('99.0.0'),
      [releaseSumsUrl('99.0.0')]: sumsRoute('99.0.0', [legacyReleaseTarballName('99.0.0')]),
    });
    expect((await checkForUpdate()).hasUpdate).toBe(true);
  });

  test('latest tag without uploaded assets yet (SHA256SUMS 404) → no tarball, not an error', async () => {
    mockRoutes({
      [RELEASE_LATEST_URL]: redirectTo(tagLocation('99.0.0')),
      [releaseChangelogUrl('99.0.0')]: text(200, 'notes'),
    });

    const result = await checkForUpdate();
    expect(result.latestVersion).toBe('99.0.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.publishedAt).toBeNull();
    expect(result.changelog).toBeNull();
  });

  test('missing last-modified → publishedAt null', async () => {
    mockRoutes({
      ...releaseRoutes('99.0.0'),
      [releaseSumsUrl('99.0.0')]: text(200, sumsBody('99.0.0')),
    });
    const result = await checkForUpdate();
    expect(result.hasUpdate).toBe(true);
    expect(result.publishedAt).toBeNull();
  });
});

describe('changelog is best-effort', () => {
  const failures: Array<[string, Route]> = [
    ['404', text(404, 'Not Found')],
    ['500', text(500, 'boom')],
    ['blank body', text(200, '  \n ')],
    [
      'network error',
      () => {
        throw new Error('ECONNRESET');
      },
    ],
  ];

  for (const [label, route] of failures) {
    test(`${label} → changelog null, release still upgradable`, async () => {
      mockRoutes({ ...releaseRoutes('99.0.0'), [releaseChangelogUrl('99.0.0')]: route });
      const result = await checkForUpdate();
      expect(result.hasUpdate).toBe(true);
      expect(result.changelog).toBeNull();
    });
  }
});

describe('latest redirect parsing', () => {
  function latestVia(route: Route): void {
    mockRoutes({ ...releaseRoutes('2.3.4'), [RELEASE_LATEST_URL]: route });
  }

  test('absolute Location', async () => {
    latestVia(redirectTo(tagLocation('2.3.4')));
    expect((await fetchLatestGithubRelease()).latestVersion).toBe('2.3.4');
  });

  test('relative Location', async () => {
    latestVia(redirectTo('/12dora/vibe-term/releases/tag/v2.3.4'));
    expect((await fetchLatestGithubRelease()).latestVersion).toBe('2.3.4');
  });

  for (const location of [
    'https://example.com/elsewhere',
    '/12dora/vibe-term/releases',
    'not a url',
    'https://github.com/other/repo/releases/tag/v2.3.4',
  ]) {
    test(`garbage Location ${JSON.stringify(location)} → ReleaseUnavailableError`, async () => {
      latestVia(redirectTo(location));
      await expect(fetchLatestGithubRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
    });
  }

  test('redirect without Location → ReleaseUnavailableError', async () => {
    latestVia(() => new Response(null, { status: 302 }));
    await expect(fetchLatestGithubRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
  });

  test('200 instead of a redirect → ReleaseUnavailableError', async () => {
    latestVia(text(200, '<html></html>'));
    await expect(fetchLatestGithubRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
  });

  test('network error → ReleaseUnavailableError', async () => {
    latestVia(() => {
      throw new Error('ENOTFOUND');
    });
    await expect(fetchLatestGithubRelease()).rejects.toThrow(ReleaseUnavailableError);
  });
});

describe('fetchLatestGithubRelease / requireLatestUpgradeRelease', () => {
  test('returns the plain release shape without comparing the local node', async () => {
    mockRoutes(releaseRoutes('2.3.4', '## 2.3.4'));

    const result = await fetchLatestGithubRelease();
    expect(result).toEqual({
      latestVersion: '2.3.4',
      changelog: '## 2.3.4',
      publishedAt: LAST_MODIFIED_ISO,
      hasTarball: true,
    });
    expect('hasUpdate' in result).toBe(false);
  });

  test('requireLatestUpgradeRelease returns the concrete version when a tarball exists', async () => {
    mockRoutes(releaseRoutes('2.3.4', 'notes'));
    await expect(requireLatestUpgradeRelease()).resolves.toEqual({
      latestVersion: '2.3.4',
      changelog: 'notes',
      publishedAt: LAST_MODIFIED_ISO,
    });
  });

  test('requireLatestUpgradeRelease throws ReleaseUnavailableError without a tarball', async () => {
    mockRoutes({
      ...releaseRoutes('2.3.4'),
      [releaseSumsUrl('2.3.4')]: sumsRoute('2.3.4', []),
    });
    await expect(requireLatestUpgradeRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
  });

  test('requireLatestUpgradeRelease surfaces an unreachable latest as ReleaseUnavailableError', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: text(502, 'bad gateway') });
    await expect(requireLatestUpgradeRelease()).rejects.toThrow(/HTTP 502/);
  });
});

describe('requirePublishedUpgradeRelease', () => {
  test('returns the tagged release when SHA256SUMS lists the tarball, without fetching notes', async () => {
    mockRoutes(releaseRoutes('1.2.3', 'notes'));
    await expect(requirePublishedUpgradeRelease('1.2.3')).resolves.toEqual({
      latestVersion: '1.2.3',
      changelog: null,
      publishedAt: LAST_MODIFIED_ISO,
    });
    expect(captures.map((c) => c.url)).toContain(releaseSumsUrl('1.2.3'));
    expect(hits(releaseChangelogUrl('1.2.3'))).toBe(0);
    expect(hits(RELEASE_LATEST_URL)).toBe(0);
  });

  test('SHA256SUMS 404 → ReleaseNotFoundError', async () => {
    mockRoutes({});
    await expect(requirePublishedUpgradeRelease('0.0.1')).rejects.toBeInstanceOf(
      ReleaseNotFoundError
    );
  });

  test('SHA256SUMS without a tarball → ReleaseNotFoundError', async () => {
    mockRoutes({ [releaseSumsUrl('1.2.3')]: sumsRoute('1.2.3', ['other.tgz']) });
    await expect(requirePublishedUpgradeRelease('1.2.3')).rejects.toBeInstanceOf(
      ReleaseNotFoundError
    );
  });

  test('SHA256SUMS HTTP 500 → ReleaseUnavailableError, not NotFound', async () => {
    mockRoutes({ [releaseSumsUrl('1.2.3')]: text(500, 'boom') });
    const err = await requirePublishedUpgradeRelease('1.2.3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseUnavailableError);
    expect(err).not.toBeInstanceOf(ReleaseNotFoundError);
  });

  test('follows a redirect to githubusercontent for SHA256SUMS', async () => {
    const cdn = 'https://release-assets.githubusercontent.com/sums-1.2.3';
    mockRoutes({
      ...releaseRoutes('1.2.3'),
      [releaseSumsUrl('1.2.3')]: redirectTo(cdn),
      [cdn]: sumsRoute('1.2.3'),
    });
    const result = await requirePublishedUpgradeRelease('1.2.3');
    expect(result.publishedAt).toBe(LAST_MODIFIED_ISO);
    expect(hits(cdn)).toBe(1);
  });

  test('refuses a redirect to a foreign host', async () => {
    const evil = 'https://evil.example.com/SHA256SUMS';
    mockRoutes({ [releaseSumsUrl('1.2.3')]: redirectTo(evil), [evil]: sumsRoute('1.2.3') });
    await expect(requirePublishedUpgradeRelease('1.2.3')).rejects.toBeInstanceOf(
      ReleaseUnavailableError
    );
    expect(hits(evil)).toBe(0);
  });
});
