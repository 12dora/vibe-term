import {
  RELEASE_LATEST_URL,
  legacyReleaseTarballName,
  parseReleaseTagLocation,
  parseSha256Sums,
  releaseChangelogUrl,
  releaseSumsUrl,
  releaseTarballName,
} from '@vibeterm/shared';
import { followReleaseRedirects } from '../../../../packages/shared/src/release/redirect';
import { getBaseVersion } from './version';

const FETCH_TIMEOUT_MS = 10_000;
const RATE_LIMIT_DEFAULT_RETRY_MS = 5 * 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

export type LatestGithubRelease = {
  latestVersion: string | null;
  changelog: string | null;
  publishedAt: string | null;
  hasTarball: boolean;
};

export class ReleaseUnavailableError extends Error {
  readonly code = 'RELEASE_UNAVAILABLE' as const;

  constructor(
    message = 'RELEASE_UNAVAILABLE',
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = 'ReleaseUnavailableError';
  }
}

export class ReleaseNotFoundError extends Error {
  readonly code = 'RELEASE_NOT_FOUND' as const;

  constructor(message = 'RELEASE_NOT_FOUND') {
    super(message);
    this.name = 'ReleaseNotFoundError';
  }
}

function requestHeaders(): Record<string, string> {
  return { 'user-agent': `vibeterm/${getBaseVersion()}` };
}

function parseRetryAfterMs(header: string | null, now: number): number | null {
  const raw = header?.trim();
  if (!raw) return null;
  const seconds = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds, RETRY_AFTER_MAX_MS);
}

function httpUnavailable(what: string, res: Response): ReleaseUnavailableError {
  const limited = res.status === 403 || res.status === 429;
  const retryAfterMs = limited
    ? (parseRetryAfterMs(res.headers.get('retry-after'), Date.now()) ?? RATE_LIMIT_DEFAULT_RETRY_MS)
    : null;
  const suffix = limited ? ': rate-limited or forbidden' : '';
  return new ReleaseUnavailableError(`${what} HTTP ${res.status}${suffix}`, retryAfterMs);
}

function asUnavailable(what: string, err: unknown): Error {
  if (err instanceof ReleaseUnavailableError || err instanceof ReleaseNotFoundError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new ReleaseUnavailableError(`${what} failed: ${detail}`);
}

/** `releases/latest` 的 302 Location → 版本号，不走 GitHub REST API，不占其配额。 */
export async function lookupLatestVersion(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(RELEASE_LATEST_URL, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      headers: requestHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw asUnavailable('GitHub latest release lookup', err);
  }
  await res.body?.cancel().catch(() => {});
  const location = res.headers.get('location');
  if (res.status < 300 || res.status >= 400) throw httpUnavailable('GitHub latest release', res);
  const version = location ? parseReleaseTagLocation(location) : null;
  if (!version) throw new ReleaseUnavailableError('GitHub latest release: unexpected redirect');
  return version;
}

type ReleaseSums = { hasTarball: boolean; publishedAt: string | null };

function lastModifiedIso(header: string | null): string | null {
  const ms = header ? Date.parse(header) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** SHA256SUMS 既是存在性探针（404 = 未发布）也是资产清单与发布时间来源。 */
async function fetchReleaseSums(version: string): Promise<ReleaseSums> {
  try {
    const { res } = await followReleaseRedirects(releaseSumsUrl(version), fetch, {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new ReleaseNotFoundError(`release ${version} has no SHA256SUMS`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw httpUnavailable('GitHub release SHA256SUMS', res);
    }
    const sums = parseSha256Sums(await res.text());
    // 新旧资产任一存在即可升级：改名后的 release 两份都传，混合版本的节点各取所需。
    const hasTarball =
      sums.has(releaseTarballName(version)) || sums.has(legacyReleaseTarballName(version));
    return { hasTarball, publishedAt: lastModifiedIso(res.headers.get('last-modified')) };
  } catch (err) {
    throw asUnavailable('GitHub release SHA256SUMS', err);
  }
}

/** 发行说明取 tag 上的 CHANGELOG.md；尽力而为，任何失败都只是没有说明。 */
async function fetchReleaseChangelog(version: string): Promise<string | null> {
  try {
    const res = await fetch(releaseChangelogUrl(version), {
      cache: 'no-store',
      headers: requestHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await res.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** 指定版本的发行信息；SHA256SUMS 404 抛 ReleaseNotFoundError，其余失败抛 ReleaseUnavailableError。 */
export async function lookupRelease(version: string): Promise<LatestGithubRelease> {
  const [sums, changelog] = await Promise.all([
    fetchReleaseSums(version),
    fetchReleaseChangelog(version),
  ]);
  return { latestVersion: version, changelog, ...sums };
}

/** latest 指向的 tag 若资产尚未上传（发版窗口期），照常回报版本但 hasTarball=false。 */
export async function lookupLatestRelease(): Promise<LatestGithubRelease> {
  const version = await lookupLatestVersion();
  try {
    return await lookupRelease(version);
  } catch (err) {
    if (!(err instanceof ReleaseNotFoundError)) throw err;
    return { latestVersion: version, changelog: null, publishedAt: null, hasTarball: false };
  }
}
