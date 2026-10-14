import {
  RELEASE_LATEST_URL,
  legacyReleaseTarballName,
  releaseChangelogUrl,
  releaseSumsUrl,
  releaseTarballName,
} from '@vibeterm/shared';

export type ReleaseLookupMockOptions = {
  tarball?: boolean;
  /** undefined → 'notes'；null → changelog 404 */
  changelog?: string | null;
  /** SHA256SUMS 的 last-modified；null → 不带该头 */
  publishedAt?: string | null;
  /** 非 200 时所有查询请求都回该状态 */
  status?: number;
  /** 除 latest 外还已发布的版本 */
  publishedVersions?: string[];
};

export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** 发行查询（latest 重定向 / SHA256SUMS / CHANGELOG）都带 `vibeterm/<version>` UA，下载请求不带。 */
export function isReleaseLookupRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const ua = new Headers(init?.headers).get('user-agent') ?? '';
  if (ua.startsWith('vibeterm/')) return true;
  return requestUrl(input) === RELEASE_LATEST_URL;
}

function sumsResponse(version: string, opts: ReleaseLookupMockOptions): Response {
  const names =
    opts.tarball === false ? [] : [releaseTarballName(version), legacyReleaseTarballName(version)];
  const body = names.map((name) => `${'a'.repeat(64)}  ${name}\n`).join('');
  const publishedAt =
    opts.publishedAt === undefined ? '2026-08-30T00:00:00.000Z' : opts.publishedAt;
  const headers: Record<string, string> = publishedAt
    ? { 'last-modified': new Date(publishedAt).toUTCString() }
    : {};
  return new Response(body, { status: 200, headers });
}

/** 内存版 GitHub 发行查询：latest 指向 `version`，`version` 与 `publishedVersions` 有 SHA256SUMS。 */
export function releaseLookupFetch(
  version: string,
  opts: ReleaseLookupMockOptions = {}
): typeof fetch {
  const published = new Set([version, ...(opts.publishedVersions ?? [])]);
  return (async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (opts.status && opts.status !== 200) {
      return new Response('unavailable', { status: opts.status });
    }
    if (url === RELEASE_LATEST_URL) {
      const location = `https://github.com/12dora/vibe-term/releases/tag/v${version}`;
      return new Response(null, { status: 302, headers: { location } });
    }
    for (const v of published) {
      if (url === releaseSumsUrl(v)) return sumsResponse(v, opts);
      if (url === releaseChangelogUrl(v)) {
        const changelog = opts.changelog === undefined ? 'notes' : opts.changelog;
        return changelog === null
          ? new Response('Not Found', { status: 404 })
          : new Response(changelog, { status: 200 });
      }
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
}

/** 在 `next` 之前补一个已发布版本（带 tarball）的 SHA256SUMS / CHANGELOG 查询。 */
export function withPublishedRelease(next: typeof fetch, version: string): typeof fetch {
  const own = releaseLookupFetch(version, { publishedVersions: [version] });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const ownUrl = url === releaseSumsUrl(version) || url === releaseChangelogUrl(version);
    if (ownUrl && isReleaseLookupRequest(input, init)) return own(input, init);
    return next(input, init);
  }) as typeof fetch;
}
