import { afterEach, describe, expect, test } from 'bun:test';
import { RELEASE_API_LATEST_URL, releaseTarballName } from '@tmex/shared';
import { checkForUpdate } from './update-check';
import { getBaseVersion } from './version';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface GithubReleaseFixture {
  tag_name?: string;
  published_at?: string | null;
  body?: string | null;
  assets?: Array<{ name: string }>;
}

interface CapturedFetch {
  url: string;
  accept: string | null;
  apiVersion: string | null;
  cache: RequestCache | undefined;
}

const captures: CapturedFetch[] = [];

function headerOf(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? null;
  }
  const rec = headers as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : null;
}

function mockGithub(status: number, body: GithubReleaseFixture | string): void {
  captures.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captures.push({
      url,
      accept: headerOf(init?.headers, 'accept'),
      apiVersion: headerOf(init?.headers, 'X-GitHub-Api-Version'),
      cache: init?.cache,
    });
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('checkForUpdate', () => {
  test('newer GitHub release with tarball asset → hasUpdate true and changelog', async () => {
    const current = getBaseVersion();
    expect(current).not.toBe('unknown');

    const latest = '99.0.0';
    const publishedAt = '2026-08-01T12:00:00Z';
    const changelog = '## 99.0.0\n\n- GitHub release notes';
    mockGithub(200, {
      tag_name: `v${latest}`,
      published_at: publishedAt,
      body: changelog,
      assets: [{ name: releaseTarballName(latest) }],
    });

    const result = await checkForUpdate();

    expect(result.currentVersion).toBe(current);
    expect(result.latestVersion).toBe(latest);
    expect(result.hasUpdate).toBe(true);
    expect(result.changelog).toBe(changelog);
    expect(result.publishedAt).toBe(publishedAt);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe(RELEASE_API_LATEST_URL);
    expect(captures[0]?.accept).toBe('application/vnd.github+json');
    expect(captures[0]?.apiVersion).toBe('2022-11-28');
    expect(captures[0]?.cache).toBe('no-store');
  });

  test('same version → hasUpdate false', async () => {
    const current = getBaseVersion();
    mockGithub(200, {
      tag_name: `v${current}`,
      published_at: '2026-01-01T00:00:00Z',
      body: 'same',
      assets: [{ name: releaseTarballName(current) }],
    });

    const result = await checkForUpdate();
    expect(result.latestVersion).toBe(current);
    expect(result.hasUpdate).toBe(false);
    expect(result.changelog).toBe('same');
  });

  test('newer tag without matching tarball asset → hasUpdate false, latestVersion still reported', async () => {
    mockGithub(200, {
      tag_name: 'v99.0.0',
      published_at: '2026-08-01T00:00:00Z',
      body: 'notes',
      assets: [{ name: 'source.tar.gz' }],
    });

    const result = await checkForUpdate();
    expect(result.latestVersion).toBe('99.0.0');
    expect(result.hasUpdate).toBe(false);
    expect(result.changelog).toBe('notes');
  });

  test('HTTP 403 throws a GitHub Releases error and never falls back to npm', async () => {
    mockGithub(403, '{"message":"API rate limit exceeded"}');

    await expect(checkForUpdate()).rejects.toThrow(/GitHub Releases API HTTP 403/i);
    expect(captures.every((c) => !c.url.includes('registry.npmjs.org'))).toBe(true);
    expect(captures.every((c) => !c.url.includes('jsdelivr'))).toBe(true);
  });

  test('empty release body → changelog null', async () => {
    mockGithub(200, {
      tag_name: 'v99.0.0',
      published_at: '2026-08-01T00:00:00Z',
      body: '   ',
      assets: [{ name: releaseTarballName('99.0.0') }],
    });

    const result = await checkForUpdate();
    expect(result.latestVersion).toBe('99.0.0');
    expect(result.hasUpdate).toBe(true);
    expect(result.changelog).toBeNull();
  });

  test('HTTP 404 throws a clear GitHub Releases error', async () => {
    mockGithub(404, '{"message":"Not Found"}');
    await expect(checkForUpdate()).rejects.toThrow(/GitHub Releases API HTTP 404/i);
  });
});
