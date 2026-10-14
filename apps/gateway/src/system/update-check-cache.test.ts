import { describe, expect, test } from 'bun:test';
import { RELEASE_LATEST_URL, releaseChangelogUrl, releaseSumsUrl } from '@vibeterm/shared';
import {
  MIN,
  captures,
  hits,
  mockRoutes,
  redirectTo,
  releaseRoutes,
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
  resetLatestReleaseCache,
} from './update-check';

const env = useReleaseTestEnv();

describe('latest release 缓存', () => {
  test('成功结果 10 min 内复用，checkForUpdate 与远程升级共享同一次查询', async () => {
    mockRoutes(releaseRoutes('9.9.9'));

    await fetchLatestGithubRelease();
    env.advance(9 * MIN);
    await requireLatestUpgradeRelease();
    await checkForUpdate();

    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    expect(hits(releaseSumsUrl('9.9.9'))).toBe(1);
    expect(hits(releaseChangelogUrl('9.9.9'))).toBe(1);
  });

  test('成功结果 10 min 后过期并重新查询', async () => {
    mockRoutes(releaseRoutes('9.9.9'));
    await fetchLatestGithubRelease();
    env.advance(10 * MIN + 1);
    await fetchLatestGithubRelease();
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });

  test('资产尚未上传的 latest 只缓存 60 s', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: redirectTo(tagLocation('9.9.9')) });
    await fetchLatestGithubRelease();
    env.advance(30_000);
    await fetchLatestGithubRelease();
    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    env.advance(31_000);
    await fetchLatestGithubRelease();
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });

  test('并发调用合并成一次查询', async () => {
    mockRoutes(releaseRoutes('9.9.9'));

    const all = await Promise.all([
      fetchLatestGithubRelease(),
      fetchLatestGithubRelease(),
      fetchLatestGithubRelease(),
    ]);

    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    expect(hits(releaseSumsUrl('9.9.9'))).toBe(1);
    expect(all.every((r) => r.latestVersion === '9.9.9')).toBe(true);
  });

  test('resetLatestReleaseCache 后重新查询', async () => {
    mockRoutes(releaseRoutes('9.9.9'));
    await fetchLatestGithubRelease();
    resetLatestReleaseCache();
    await fetchLatestGithubRelease();
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });
});

describe('失败负缓存', () => {
  test('普通失败缓存 60 s：期间不重试，之后重试', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: text(502, 'bad gateway') });
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 502/);
    env.advance(59_000);
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 502/);
    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    env.advance(2_000);
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 502/);
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });

  test('429 + Retry-After(秒) 按其时长负缓存', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: text(429, 'slow down', { 'retry-after': '120' }) });
    await expect(fetchLatestGithubRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
    env.advance(119_000);
    await expect(fetchLatestGithubRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    env.advance(2_000);
    await expect(fetchLatestGithubRelease()).rejects.toBeInstanceOf(ReleaseUnavailableError);
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });

  test('403 + Retry-After(HTTP 日期) 按其时长负缓存', async () => {
    const retryAt = new Date(env.now() + 90_000).toUTCString();
    mockRoutes({ [RELEASE_LATEST_URL]: text(403, 'forbidden', { 'retry-after': retryAt }) });
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 403/);
    env.advance(80_000);
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 403/);
    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    env.advance(15_000);
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 403/);
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });

  test('403 / 429 缺 Retry-After → 5 min', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: text(429, 'slow down') });
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 429/);
    env.advance(4 * MIN);
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 429/);
    expect(hits(RELEASE_LATEST_URL)).toBe(1);
    env.advance(MIN + 1);
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 429/);
    expect(hits(RELEASE_LATEST_URL)).toBe(2);
  });

  test('负缓存期间恢复不会被看到，过期后恢复正常', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: text(502, 'bad gateway') });
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 502/);
    mockRoutes(releaseRoutes('9.9.9'));
    await expect(fetchLatestGithubRelease()).rejects.toThrow(/HTTP 502/);
    expect(captures).toHaveLength(0);
    env.advance(61_000);
    expect((await fetchLatestGithubRelease()).latestVersion).toBe('9.9.9');
  });

  test('并发失败合并成一次请求', async () => {
    mockRoutes({ [RELEASE_LATEST_URL]: text(502, 'bad gateway') });
    const results = await Promise.allSettled([
      fetchLatestGithubRelease(),
      fetchLatestGithubRelease(),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(hits(RELEASE_LATEST_URL)).toBe(1);
  });
});

describe('指定版本缓存', () => {
  test('成功结果缓存 1 h 且并发合并', async () => {
    mockRoutes(releaseRoutes('1.2.3'));
    await Promise.all([
      requirePublishedUpgradeRelease('1.2.3'),
      requirePublishedUpgradeRelease('1.2.3'),
    ]);
    env.advance(59 * MIN);
    await requirePublishedUpgradeRelease('1.2.3');
    expect(hits(releaseSumsUrl('1.2.3'))).toBe(1);
    env.advance(2 * MIN);
    await requirePublishedUpgradeRelease('1.2.3');
    expect(hits(releaseSumsUrl('1.2.3'))).toBe(2);
  });

  test('404 只缓存 60 s，发布后很快可见', async () => {
    mockRoutes({});
    await expect(requirePublishedUpgradeRelease('1.2.3')).rejects.toBeInstanceOf(
      ReleaseNotFoundError
    );
    env.advance(30_000);
    await expect(requirePublishedUpgradeRelease('1.2.3')).rejects.toBeInstanceOf(
      ReleaseNotFoundError
    );
    expect(hits(releaseSumsUrl('1.2.3'))).toBe(1);

    mockRoutes(releaseRoutes('1.2.3'));
    env.advance(31_000);
    await expect(requirePublishedUpgradeRelease('1.2.3')).resolves.toMatchObject({
      latestVersion: '1.2.3',
    });
  });

  test('不同版本互不影响', async () => {
    mockRoutes({ ...releaseRoutes('1.2.3'), ...releaseRoutes('1.2.4') });
    await requirePublishedUpgradeRelease('1.2.3');
    await requirePublishedUpgradeRelease('1.2.4');
    expect(hits(releaseSumsUrl('1.2.3'))).toBe(1);
    expect(hits(releaseSumsUrl('1.2.4'))).toBe(1);
  });
});
