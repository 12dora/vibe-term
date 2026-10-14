import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASE_LATEST_URL,
  legacyReleaseTarballName,
  legacyReleaseTarballUrl,
  releaseTarballName,
  releaseTarballUrl,
} from '../../../shared/src/release/source';
import { t } from '../i18n';
import {
  downloadReleaseTarball,
  fetchReleaseSha256Sums,
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

describe('resolveReleaseVersion', () => {
  test('uses an explicit version without any lookup', async () => {
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

  function redirectResponse(location: string | null, status = 302): Response {
    return new Response(null, {
      status,
      headers: location === null ? {} : { Location: location },
    });
  }

  test('resolves latest from the releases/latest 302 without following it', async () => {
    const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const version = await resolveReleaseVersion('latest', async (url, init) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      return redirectResponse('https://github.com/12dora/vibe-term/releases/tag/v1.4.0');
    });
    expect(version).toBe('1.4.0');
    expect(calls).toEqual([{ url: RELEASE_LATEST_URL, redirect: 'manual' }]);
  });

  test('resolves an empty request as latest and accepts a relative Location', async () => {
    const version = await resolveReleaseVersion('', async () =>
      redirectResponse('/12dora/vibe-term/releases/tag/v2.0.0-rc.1')
    );
    expect(version).toBe('2.0.0-rc.1');
  });

  test('maps HTTP 404 and garbage Location to latestLookupFailed', async () => {
    await expect(
      resolveReleaseVersion('latest', async () => jsonResponse(404, '{"message":"Not Found"}'))
    ).rejects.toThrow(t('upgrade.latestLookupFailed'));
    await expect(
      resolveReleaseVersion('latest', async () => redirectResponse('https://github.com/login'))
    ).rejects.toThrow(t('upgrade.latestLookupFailed'));
    await expect(
      resolveReleaseVersion('latest', async () => redirectResponse(null))
    ).rejects.toThrow(t('upgrade.latestLookupFailed'));
  });

  test('maps other HTTP failures and network errors to networkFailed', async () => {
    await expect(
      resolveReleaseVersion('latest', async () => jsonResponse(503, 'down'))
    ).rejects.toThrow(t('upgrade.networkFailed', { detail: 'HTTP 503' }));
    await expect(
      resolveReleaseVersion('latest', async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      })
    ).rejects.toThrow(t('upgrade.networkFailed', { detail: 'getaddrinfo ENOTFOUND' }));
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
      expect(seen.some((url) => url === releaseTarballUrl('1.1.40'))).toBe(true);
      expect(seen.some((url) => url === legacyReleaseTarballUrl('1.1.40'))).toBe(true);
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

  test('passes an abort signal (overall timeout) and logs the download line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-dl-timeout-'));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(String(args[0] ?? ''));
    };
    try {
      const dest = join(dir, releaseTarballName('1.2.0'));
      let sawSignal = false;
      const asset = await downloadReleaseTarball('1.2.0', dest, async (url, init) => {
        if (init?.signal) sawSignal = true;
        expect(String(url)).toBe(releaseTarballUrl('1.2.0'));
        return new Response(Buffer.from('streamed-bytes'), { status: 200 });
      });
      expect(asset).toBe(releaseTarballName('1.2.0'));
      expect(sawSignal).toBe(true);
      expect(await readFile(dest, 'utf8')).toBe('streamed-bytes');
      expect(
        logs.some((line) => line.startsWith('[upgrade] download url=') && line.includes('verdict='))
      ).toBe(true);
    } finally {
      console.log = originalLog;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
