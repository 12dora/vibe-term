import type { UpdateCheckResult } from '@tmex/shared';
import { RELEASE_API_LATEST_URL, releaseTarballName } from '@tmex/shared';
import { compareVersions } from './semver';
import { getBaseVersion } from './version';

const FETCH_TIMEOUT_MS = 10_000;

interface GithubReleaseAsset {
  name?: string;
}

interface GithubRelease {
  tag_name?: string;
  published_at?: string | null;
  body?: string | null;
  assets?: GithubReleaseAsset[];
}

/**
 * 查询本仓库 GitHub Releases 最新版（不再走 npm registry）。
 * changelog 取 release body（markdown）；空则 null。缺少对应 tarball 资产时
 * 仍回报 latestVersion，但 hasUpdate=false，避免前端提供无法完成的升级。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = getBaseVersion();

  const res = await fetch(RELEASE_API_LATEST_URL, {
    cache: 'no-store',
    headers: {
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw githubReleasesHttpError(res.status);
  }

  const release = (await res.json()) as GithubRelease;
  const latest = stripLeadingV(release.tag_name);
  const publishedAt = latest ? (release.published_at ?? null) : null;
  const changelog = releaseChangelog(release.body);
  const hasTarball =
    latest !== null &&
    Array.isArray(release.assets) &&
    release.assets.some((asset) => asset.name === releaseTarballName(latest));
  const hasUpdate =
    latest !== null && hasTarball && current !== 'unknown' && compareVersions(latest, current) > 0;

  return {
    currentVersion: current,
    latestVersion: latest,
    hasUpdate,
    changelog,
    publishedAt,
  };
}

function stripLeadingV(tag: string | undefined): string | null {
  if (typeof tag !== 'string' || tag.length === 0) return null;
  return tag.replace(/^v/, '') || null;
}

function releaseChangelog(body: string | null | undefined): string | null {
  if (typeof body !== 'string') return null;
  return body.trim() ? body : null;
}

function githubReleasesHttpError(status: number): Error {
  if (status === 403 || status === 429) {
    return new Error(`GitHub Releases API HTTP ${status}: rate-limited or forbidden`);
  }
  if (status === 404) {
    return new Error('GitHub Releases API HTTP 404: release not found');
  }
  return new Error(`GitHub Releases API HTTP ${status}`);
}
