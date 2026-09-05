import {
  RELEASE_API_LATEST_URL,
  RELEASE_REPO_URL,
  releaseTag,
  releaseTarballName,
  releaseTarballUrl,
} from '../../../shared/src/release/source';
import { parseSha256Sums } from '../../../shared/src/release/verify';
import { t } from '../i18n';
import { errorMessage } from './error-message';
import { writeBytesAtomic } from './fs-utils';

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'tmex-cli',
};

export type ReleaseFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function assertReleaseVersion(version: string): string {
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error(t('errors.version.invalid', { input: version }));
  }
  return version;
}

export function versionFromTagName(tagName: string): string {
  return tagName.trim().replace(/^v/i, '');
}

export function parseLatestReleaseVersion(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(t('upgrade.latestLookupFailed'));
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(t('upgrade.latestLookupFailed'));
  }
  const tag = (parsed as { tag_name?: unknown }).tag_name;
  if (typeof tag !== 'string' || !tag.trim()) {
    throw new Error(t('upgrade.latestLookupFailed'));
  }
  return versionFromTagName(tag);
}

function networkError(detail: string): Error {
  return new Error(t('upgrade.networkFailed', { detail }));
}

async function githubFetch(
  url: string,
  fetchFn: ReleaseFetch,
  versionLabel: string
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: GITHUB_HEADERS, redirect: 'follow' });
  } catch (error) {
    const detail = errorMessage(error);
    throw networkError(detail);
  }
  if (response.status === 404) {
    throw new Error(t('upgrade.versionNotFound', { version: versionLabel }));
  }
  if (!response.ok) {
    throw networkError(`HTTP ${response.status}`);
  }
  return response;
}

export async function resolveReleaseVersion(
  requested: string,
  fetchFn: ReleaseFetch = fetch
): Promise<string> {
  const trimmed = requested.trim();
  if (trimmed && trimmed !== 'latest') {
    return assertReleaseVersion(versionFromTagName(trimmed));
  }
  const response = await githubFetch(RELEASE_API_LATEST_URL, fetchFn, 'latest');
  const body = await response.text();
  return parseLatestReleaseVersion(body);
}

export async function downloadReleaseTarball(
  version: string,
  destFile: string,
  fetchFn: ReleaseFetch = fetch
): Promise<void> {
  const response = await githubFetch(releaseTarballUrl(version), fetchFn, version);
  const buf = Buffer.from(await response.arrayBuffer());
  await writeBytesAtomic(destFile, buf);
}

export function releaseSha256SumsUrl(version: string): string {
  return `${RELEASE_REPO_URL}/releases/download/${releaseTag(version)}/SHA256SUMS`;
}

export async function fetchReleaseSha256Sums(
  version: string,
  fileName: string,
  fetchFn: ReleaseFetch = fetch
): Promise<{ hex: string | null; missing: boolean; unpublished: boolean }> {
  let response: Response;
  try {
    response = await fetchFn(releaseSha256SumsUrl(version), {
      headers: GITHUB_HEADERS,
      redirect: 'follow',
    });
  } catch (error) {
    const detail = errorMessage(error);
    throw new Error(t('upgrade.checksumHttpFailed', { detail }));
  }
  if (response.status === 404) return { hex: null, missing: true, unpublished: true };
  if (!response.ok) {
    throw new Error(t('upgrade.checksumHttpFailed', { detail: `HTTP ${response.status}` }));
  }
  const hex = parseSha256Sums(await response.text(), fileName || releaseTarballName(version));
  return { hex, missing: hex === null, unpublished: false };
}
