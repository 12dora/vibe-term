import {
  RELEASE_API_LATEST_URL,
  RELEASE_REPO_URL,
  legacyReleaseTarballName,
  legacyReleaseTarballUrl,
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
  'User-Agent': 'vibeterm-cli',
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

/** 404 返回 null（调用方据此决定是否回退到旧资产名），其余失败一律抛错。 */
async function githubFetchOrNull(url: string, fetchFn: ReleaseFetch): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: GITHUB_HEADERS, redirect: 'follow' });
  } catch (error) {
    const detail = errorMessage(error);
    throw networkError(detail);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw networkError(`HTTP ${response.status}`);
  }
  return response;
}

async function githubFetch(
  url: string,
  fetchFn: ReleaseFetch,
  versionLabel: string
): Promise<Response> {
  const response = await githubFetchOrNull(url, fetchFn);
  if (response === null) {
    throw new Error(t('upgrade.versionNotFound', { version: versionLabel }));
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

/**
 * 下载发行 tarball，返回实际命中的资产名。新名 404 时回退到改名前的资产名——
 * 桥接期间可能存在只发了旧名资产的 release，摘要查表要按命中的名字来。
 */
export async function downloadReleaseTarball(
  version: string,
  destFile: string,
  fetchFn: ReleaseFetch = fetch
): Promise<string> {
  const primary = await githubFetchOrNull(releaseTarballUrl(version), fetchFn);
  if (primary !== null) {
    await writeBytesAtomic(destFile, Buffer.from(await primary.arrayBuffer()));
    return releaseTarballName(version);
  }
  const legacy = await githubFetch(legacyReleaseTarballUrl(version), fetchFn, version);
  await writeBytesAtomic(destFile, Buffer.from(await legacy.arrayBuffer()));
  return legacyReleaseTarballName(version);
}

export function releaseSha256SumsUrl(version: string): string {
  return `${RELEASE_REPO_URL}/releases/download/${releaseTag(version)}/SHA256SUMS`;
}

export function releaseSha256SumsSigUrl(version: string): string {
  return `${releaseSha256SumsUrl(version)}.sig`;
}

/** 取发行包签名行；404（老 release 没有这个资产）返回 null，由调用方按版本门槛判定。 */
export async function fetchReleaseSumsSignature(
  version: string,
  fetchFn: ReleaseFetch = fetch
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchFn(releaseSha256SumsSigUrl(version), {
      headers: GITHUB_HEADERS,
      redirect: 'follow',
    });
  } catch (error) {
    throw new Error(t('upgrade.signatureHttpFailed', { detail: errorMessage(error) }));
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(t('upgrade.signatureHttpFailed', { detail: `HTTP ${response.status}` }));
  }
  return (await response.text()).trim() || null;
}

export async function fetchReleaseSha256Sums(
  version: string,
  fileName: string,
  fetchFn: ReleaseFetch = fetch
): Promise<{ hex: string | null; missing: boolean; unpublished: boolean; text: string }> {
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
  if (response.status === 404) return { hex: null, missing: true, unpublished: true, text: '' };
  if (!response.ok) {
    throw new Error(t('upgrade.checksumHttpFailed', { detail: `HTTP ${response.status}` }));
  }
  const text = await response.text();
  const wanted = fileName || releaseTarballName(version);
  // 只列了旧名资产的 SHA256SUMS（桥接期）仍要能查到摘要。
  const hex =
    parseSha256Sums(text, wanted) ??
    (wanted === releaseTarballName(version)
      ? parseSha256Sums(text, legacyReleaseTarballName(version))
      : null);
  return { hex, missing: hex === null, unpublished: false, text };
}
