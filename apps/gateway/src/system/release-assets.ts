// 发行资产的地址与取用：URL 拼装、SHA256SUMS / SHA256SUMS.sig 的拉取与验签。
// 与「整包下载 / 缓存」分开，让 release-download 只剩字节搬运与缓存生命周期。

import { RELEASE_REPO_URL, combineAbortSignals, errorMessage } from '@tmex/shared';
import { releaseTag, releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import { assertReleaseChecksum } from '../../../../packages/shared/src/release/verify';
import { type VerifiedReleaseSums, verifyReleaseSumsBundle } from './release-signature';

const SHA256SUMS_FETCH_TIMEOUT_MS = 30_000;

/** 覆盖 GitHub 仓库根 URL；缺省为当前发行源。路径布局保持 `/releases/download/v<ver>/...`。 */
export const RELEASE_BASE_URL_ENV = 'TMEX_RELEASE_BASE_URL';

export function resolveReleaseBaseUrl(): string {
  const override = process.env[RELEASE_BASE_URL_ENV]?.trim().replace(/\/+$/, '');
  return override && override.length > 0 ? override : RELEASE_REPO_URL;
}

export function resolveReleaseTarballUrl(version: string): string {
  const base = resolveReleaseBaseUrl();
  if (base === RELEASE_REPO_URL) return releaseTarballUrl(version);
  return `${base}/releases/download/${releaseTag(version)}/${releaseTarballName(version)}`;
}

export function resolveReleaseSha256SumsUrl(version: string): string {
  return resolveReleaseTarballUrl(version).replace(releaseTarballName(version), 'SHA256SUMS');
}

export function releaseSha256SumsUrl(version: string): string {
  return resolveReleaseSha256SumsUrl(version);
}

export function resolveReleaseSha256SumsSigUrl(version: string): string {
  return `${resolveReleaseSha256SumsUrl(version)}.sig`;
}

export function assertReleaseSha256(
  version: string,
  sha256: string,
  sums: { hex: string | null; missing: boolean }
): void {
  assertReleaseChecksum(sha256, sums, releaseTarballName(version));
}

/** 拉一个纯文本资产；404 返回 null，其余非 2xx 抛错。 */
async function fetchReleaseText(
  url: string,
  label: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      redirect: 'follow',
      cache: 'no-store',
      signal: combineAbortSignals(AbortSignal.timeout(SHA256SUMS_FETCH_TIMEOUT_MS), signal),
    });
  } catch (error) {
    throw new Error(`${label} network error: ${errorMessage(error)}`);
  }
  if (response.status === 404) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return await response.text();
}

/**
 * 取回该版本的 SHA256SUMS 与其分离签名并本地验签，返回权威摘要。
 * SHA256SUMS 缺失一律拒绝；签名缺失只对 `RELEASE_SIGNING_SINCE` 之前的版本容忍。
 */
export async function fetchVerifiedReleaseSums(
  version: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<VerifiedReleaseSums> {
  const [sums, sig] = await Promise.all([
    fetchReleaseText(resolveReleaseSha256SumsUrl(version), 'SHA256SUMS', fetchFn, signal),
    fetchReleaseText(resolveReleaseSha256SumsSigUrl(version), 'SHA256SUMS.sig', fetchFn, signal),
  ]);
  if (sums === null) {
    throw new Error(
      'Release SHA256SUMS is missing; tarball integrity is unverified. Refusing to continue.'
    );
  }
  return verifyReleaseSumsBundle(version, { sums, sig });
}
