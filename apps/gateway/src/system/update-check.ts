import { type UpdateCheckResult, compareSemver } from '@vibeterm/shared';
import {
  type LatestGithubRelease,
  ReleaseNotFoundError,
  ReleaseUnavailableError,
  lookupLatestRelease,
  lookupRelease,
} from './release-lookup';
import { TtlLookup } from './ttl-lookup';
import { getBaseVersion } from './version';

export { ReleaseNotFoundError, ReleaseUnavailableError };
export type { LatestGithubRelease };

/** latest 指向的版本发布后基本不变；更新提示晚几分钟无妨，换来对 GitHub 的低频访问。 */
const LATEST_RELEASE_TTL_MS = 10 * 60_000;
/** latest 已发 tag 但资产还没传完（发版窗口期）或更新日志没取到：短缓存，尽快补齐。 */
const LATEST_PENDING_TTL_MS = 60_000;
/** 指定版本的发行不可变，成功结果长缓存。 */
const PUBLISHED_RELEASE_TTL_MS = 60 * 60_000;
const FAILURE_TTL_MS = 60_000;

function failureTtlMs(err: unknown): number {
  return err instanceof ReleaseUnavailableError && err.retryAfterMs !== null
    ? err.retryAfterMs
    : FAILURE_TTL_MS;
}

const latestLookup = new TtlLookup<LatestGithubRelease>({
  successTtlMs: (release) =>
    release.hasTarball && release.changelog !== null
      ? LATEST_RELEASE_TTL_MS
      : LATEST_PENDING_TTL_MS,
  failureTtlMs,
});

const publishedLookup = new TtlLookup<LatestGithubRelease>({
  successTtlMs: () => PUBLISHED_RELEASE_TTL_MS,
  failureTtlMs,
  maxEntries: 64,
});

/**
 * 查询本仓库 GitHub Releases 最新版（不走 GitHub REST API，也不走 npm registry）。
 * changelog 取该 tag 的 CHANGELOG.md；缺少对应 tarball 资产时
 * 仍回报 latestVersion，但 hasUpdate=false，避免前端提供无法完成的升级。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = getBaseVersion();
  const release = await fetchLatestGithubRelease();
  const hasUpdate =
    release.latestVersion !== null &&
    release.hasTarball &&
    current !== 'unknown' &&
    (compareSemver(release.latestVersion, current) ?? 0) > 0;

  return {
    currentVersion: current,
    latestVersion: release.latestVersion,
    hasUpdate,
    changelog: release.changelog,
    publishedAt: release.publishedAt,
  };
}

export function resetLatestReleaseCache(): void {
  latestLookup.reset();
  publishedLookup.reset();
}

/**
 * 解析 GitHub latest Release；不与本机版本比较（远程升级不能用入口节点 hasUpdate）。
 * 成功缓存 10 min，失败短时负缓存（403/429 遵循 Retry-After），并发请求合并。
 */
export async function fetchLatestGithubRelease(): Promise<LatestGithubRelease> {
  return await latestLookup.get('latest', lookupLatestRelease);
}

/** 指定 tag 的发行（只用于确认可升级，不取更新日志）；SHA256SUMS 404 视为未发布。 */
export async function fetchPublishedGithubRelease(version: string): Promise<LatestGithubRelease> {
  return await publishedLookup.get(version, () => lookupRelease(version, { changelog: false }));
}

export type UpgradeRelease = {
  latestVersion: string;
  changelog: string | null;
  publishedAt: string | null;
};

/** 远程/本机升级用：必须有具体版本且存在 CLI tarball 资产。 */
export async function requireLatestUpgradeRelease(): Promise<UpgradeRelease> {
  const release = await fetchLatestGithubRelease();
  if (!release.latestVersion || !release.hasTarball) {
    throw new ReleaseUnavailableError('latest release tarball is unavailable');
  }
  return {
    latestVersion: release.latestVersion,
    changelog: release.changelog,
    publishedAt: release.publishedAt,
  };
}

/** 指定版本必须是已发布且带 CLI tarball 的发行，否则 `RELEASE_NOT_FOUND`。 */
export async function requirePublishedUpgradeRelease(version: string): Promise<UpgradeRelease> {
  const release = await fetchPublishedGithubRelease(version);
  if (!release.latestVersion || !release.hasTarball) {
    throw new ReleaseNotFoundError(`release tarball is unavailable for ${version}`);
  }
  return {
    latestVersion: release.latestVersion,
    changelog: release.changelog,
    publishedAt: release.publishedAt,
  };
}
