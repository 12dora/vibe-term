import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseTarballName, releaseTarballUrl } from '@tmex/shared';
import { stageGithubRelease } from './upgrade';

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function toResponseBody(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function packFakeCliTarball(version: string): Buffer {
  const dir = tempDir('tmex-pack-src-');
  const binDir = join(dir, 'package', 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'tmex.js'), '#!/usr/bin/env node\nconsole.log("ok");\n');
  const tgz = join(dir, releaseTarballName(version));
  const packed = spawnSync('tar', ['-czf', tgz, '-C', dir, 'package'], { encoding: 'utf8' });
  if (packed.status !== 0) {
    throw new Error(`tar pack failed: ${packed.stderr}`);
  }
  return readFileSync(tgz);
}

describe('stageGithubRelease', () => {
  test('downloads GitHub tarball, extracts npm-pack layout, returns package/bin/tmex.js', async () => {
    const version = '9.9.9';
    const bytes = packFakeCliTarball(version);
    const requested: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      expect(init?.redirect === undefined || init.redirect === 'follow').toBe(true);
      return new Response(toResponseBody(bytes), { status: 200 });
    }) as typeof fetch;

    const stageDir = tempDir('tmex-upg-stage-');
    const binPath = await stageGithubRelease(stageDir, version);

    expect(requested).toEqual([releaseTarballUrl(version)]);
    expect(binPath).toBe(join(stageDir, 'package', 'bin', 'tmex.js'));
    expect(existsSync(binPath)).toBe(true);
    expect(readFileSync(binPath, 'utf8')).toContain('console.log("ok")');
  });

  test('HTTP error while downloading tarball throws and never uses npm', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return new Response('nope', { status: 403 });
    }) as typeof fetch;

    await expect(stageGithubRelease(tempDir('tmex-upg-stage-'), '9.9.9')).rejects.toThrow(
      /GitHub release tarball HTTP 403/i
    );
    expect(requested).toEqual([releaseTarballUrl('9.9.9')]);
    expect(requested.every((url) => !url.includes('registry.npmjs.org'))).toBe(true);
  });

  test('extract without package/bin/tmex.js throws', async () => {
    const dir = tempDir('tmex-pack-empty-');
    writeFileSync(join(dir, 'readme.txt'), 'no cli\n');
    const tgz = join(dir, 'empty.tgz');
    const packed = spawnSync('tar', ['-czf', tgz, '-C', dir, 'readme.txt'], { encoding: 'utf8' });
    if (packed.status !== 0) {
      throw new Error(`tar pack failed: ${packed.stderr}`);
    }
    const bytes = readFileSync(tgz);

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(toResponseBody(bytes), { status: 200 })) as typeof fetch;

    await expect(stageGithubRelease(tempDir('tmex-upg-stage-'), '1.2.3')).rejects.toThrow(
      /downloaded tmex-cli binary not found/
    );
  });
});
