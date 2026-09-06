import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASE_API_LATEST_URL,
  legacyReleaseTarballName,
  legacyReleaseTarballUrl,
  releaseTarballName,
  releaseTarballUrl,
} from '../../../shared/src/release/source';
import { t } from '../i18n';
import {
  downloadReleaseTarball,
  fetchReleaseSha256Sums,
  parseLatestReleaseVersion,
  releaseSha256SumsUrl,
  resolveReleaseVersion,
  versionFromTagName,
} from './release-fetch';

function jsonResponse(status: number, body: string | Uint8Array): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('versionFromTagName', () => {
  test('strips a leading v', () => {
    expect(versionFromTagName('v1.1.0')).toBe('1.1.0');
    expect(versionFromTagName('1.1.0')).toBe('1.1.0');
    expect(versionFromTagName('v1.1.0-beta.1')).toBe('1.1.0-beta.1');
  });
});

describe('parseLatestReleaseVersion', () => {
  test('reads tag_name from GitHub latest-release JSON', () => {
    expect(parseLatestReleaseVersion('{"tag_name":"v1.1.0","name":"1.1.0"}')).toBe('1.1.0');
    expect(
      parseLatestReleaseVersion('{\n  "url": "https://example",\n  "tag_name": "v2.0.0"\n}')
    ).toBe('2.0.0');
  });

  test('rejects JSON without tag_name', () => {
    expect(() => parseLatestReleaseVersion('{"name":"nope"}')).toThrow();
  });
});

describe('resolveReleaseVersion', () => {
  test('uses an explicit version without calling the API', async () => {
    const calls: string[] = [];
    const version = await resolveReleaseVersion('v1.2.3', async (url) => {
      calls.push(String(url));
      return jsonResponse(500, '{}');
    });
    expect(version).toBe('1.2.3');
    expect(calls).toEqual([]);
  });

  test('rejects explicit versions that are not strict semver', async () => {
    await expect(resolveReleaseVersion('../etc/passwd')).rejects.toThrow(
      t('errors.version.invalid', { input: '../etc/passwd' })
    );
    await expect(resolveReleaseVersion('1.2')).rejects.toThrow(
      t('errors.version.invalid', { input: '1.2' })
    );
    await expect(resolveReleaseVersion('1.2.3+build')).rejects.toThrow(
      t('errors.version.invalid', { input: '1.2.3+build' })
    );
    await expect(resolveReleaseVersion('v1.2.3-beta.1')).resolves.toBe('1.2.3-beta.1');
  });

  test('fetches latest when requested version is latest or empty', async () => {
    const version = await resolveReleaseVersion('latest', async (url) => {
      expect(String(url)).toBe(RELEASE_API_LATEST_URL);
      return jsonResponse(200, '{"tag_name":"v1.4.0"}');
    });
    expect(version).toBe('1.4.0');
  });

  test('maps HTTP 404 to a version-not-found error', async () => {
    await expect(
      resolveReleaseVersion('latest', async () => jsonResponse(404, '{"message":"Not Found"}'))
    ).rejects.toThrow(t('upgrade.versionNotFound', { version: 'latest' }));
  });

  test('maps network failure to a clear error', async () => {
    await expect(
      resolveReleaseVersion('latest', async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      })
    ).rejects.toThrow(/GitHub|网络|getaddrinfo/i);
  });
});

describe('fetchReleaseSha256Sums', () => {
  test('returns missing on 404', async () => {
    const result = await fetchReleaseSha256Sums(
      '1.1.0',
      releaseTarballName('1.1.0'),
      async (url) => {
        expect(String(url)).toBe(releaseSha256SumsUrl('1.1.0'));
        return jsonResponse(404, 'nope');
      }
    );
    expect(result.missing).toBe(true);
    expect(result.unpublished).toBe(true);
    expect(result.hex).toBeNull();
  });

  test('200 without a matching line is missing but not unpublished', async () => {
    const result = await fetchReleaseSha256Sums('1.1.4', releaseTarballName('1.1.4'), async () =>
      jsonResponse(200, `${'a'.repeat(64)}  other.tgz\n`)
    );
    expect(result.missing).toBe(true);
    expect(result.unpublished).toBe(false);
    expect(result.hex).toBeNull();
  });

  test('parses the matching tarball line', async () => {
    const hex = 'a'.repeat(64);
    const result = await fetchReleaseSha256Sums('1.1.0', releaseTarballName('1.1.0'), async () =>
      jsonResponse(200, `${hex}  ${releaseTarballName('1.1.0')}\n`)
    );
    expect(result.missing).toBe(false);
    expect(result.hex).toBe(hex);
  });

  test('falls back to the pre-rename asset name when only that line is listed', async () => {
    const hex = 'b'.repeat(64);
    const result = await fetchReleaseSha256Sums('1.1.4', releaseTarballName('1.1.4'), async () =>
      jsonResponse(200, `${hex}  ${legacyReleaseTarballName('1.1.4')}\n`)
    );
    expect(result.missing).toBe(false);
    expect(result.hex).toBe(hex);
  });

  test('does not fall back when an explicit non-default file name is asked for', async () => {
    const result = await fetchReleaseSha256Sums('1.1.4', 'other.tgz', async () =>
      jsonResponse(200, `${'c'.repeat(64)}  ${legacyReleaseTarballName('1.1.4')}\n`)
    );
    expect(result.hex).toBeNull();
  });

  test('aborts on network errors instead of treating them as missing', async () => {
    await expect(
      fetchReleaseSha256Sums('1.1.0', releaseTarballName('1.1.0'), async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      })
    ).rejects.toThrow(/SHA256SUMS|ENOTFOUND|checksum/i);
  });

  test('aborts on non-2xx other than 404', async () => {
    await expect(
      fetchReleaseSha256Sums('1.1.0', releaseTarballName('1.1.0'), async () =>
        jsonResponse(500, 'nope')
      )
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('downloadReleaseTarball', () => {
  test('writes the tarball body for a successful download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-dl-'));
    try {
      const dest = join(dir, releaseTarballName('1.1.0'));
      const asset = await downloadReleaseTarball('1.1.0', dest, async (url) => {
        expect(String(url)).toBe(releaseTarballUrl('1.1.0'));
        return new Response(Buffer.from('tarball-bytes'), { status: 200 });
      });
      expect(asset).toBe(releaseTarballName('1.1.0'));
      expect(await readFile(dest, 'utf8')).toBe('tarball-bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('retries the pre-rename asset name when the new one is 404', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-dl-legacy-'));
    try {
      const dest = join(dir, releaseTarballName('1.1.40'));
      const seen: string[] = [];
      const asset = await downloadReleaseTarball('1.1.40', dest, async (url) => {
        seen.push(String(url));
        if (String(url) === releaseTarballUrl('1.1.40')) return jsonResponse(404, 'nope');
        expect(String(url)).toBe(legacyReleaseTarballUrl('1.1.40'));
        return new Response(Buffer.from('legacy-bytes'), { status: 200 });
      });
      expect(asset).toBe(legacyReleaseTarballName('1.1.40'));
      expect(seen).toHaveLength(2);
      expect(await readFile(dest, 'utf8')).toBe('legacy-bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('maps HTTP 404 to version/asset missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-dl-404-'));
    try {
      await expect(
        downloadReleaseTarball('9.9.9', join(dir, 'x.tgz'), async () => jsonResponse(404, 'nope'))
      ).rejects.toThrow(t('upgrade.versionNotFound', { version: '9.9.9' }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
