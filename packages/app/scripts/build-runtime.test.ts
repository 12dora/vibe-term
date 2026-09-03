import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRuntimeEntry, unresolvedPackageRequires } from './build-runtime';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-cpu-features-'));
  tempDirs.push(dir);
  return dir;
}

describe('unresolvedPackageRequires', () => {
  test('flags a bare cpu-features require and ignores node/bun builtins', () => {
    expect(unresolvedPackageRequires('cpuInfo = __require("cpu-features")();')).toEqual([
      'cpu-features',
    ]);
    expect(unresolvedPackageRequires('const fs = __require("fs");')).toEqual([]);
    expect(unresolvedPackageRequires('const fs = require("node:fs");')).toEqual([]);
    expect(unresolvedPackageRequires('const db = require("bun:sqlite");')).toEqual([]);
    expect(unresolvedPackageRequires('const p = require("fs/promises");')).toEqual([]);
  });
});

describe('cpu-features stub plugin', () => {
  test('inlines a throwing stub instead of leaving require("cpu-features")', async () => {
    const dir = await tempDir();
    const entry = join(dir, 'entry.js');
    const outfile = join(dir, 'out.js');
    await writeFile(
      entry,
      `try {
  require("cpu-features")();
} catch (e) {
  globalThis.__cpuFeaturesError = e;
}
`
    );

    await buildRuntimeEntry({
      entrypoint: entry,
      outfile,
      version: '0.0.0-test',
    });

    const text = await readFile(outfile, 'utf8');
    expect(text).not.toMatch(/require\(["']cpu-features["']\)/);
    expect(text).toContain('cpu-features unavailable');
    expect(unresolvedPackageRequires(text)).toEqual([]);
  });

  test('stub throw is catchable like a missing optional native dep', async () => {
    const dir = await tempDir();
    const entry = join(dir, 'entry.js');
    const outfile = join(dir, 'out.js');
    await writeFile(
      entry,
      `export function probe() {
  try {
    require("cpu-features")();
    return "loaded";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
`
    );

    await buildRuntimeEntry({
      entrypoint: entry,
      outfile,
      version: '0.0.0-test',
    });

    const mod = (await import(outfile)) as { probe: () => string };
    expect(mod.probe()).toBe('cpu-features unavailable');
  });

  const packagedServerJs = resolve(import.meta.dir, '../dist/runtime/server.js');
  // 只在跑过 build:runtime 的环境里检查产物；单测环境没有 dist。
  test.skipIf(!existsSync(packagedServerJs))(
    'packaged dist/runtime/server.js does not leave cpu-features as an external require',
    async () => {
      const text = await Bun.file(packagedServerJs).text();
      expect(text).not.toMatch(/require\(["']cpu-features["']\)/);
      expect(text).toContain('cpu-features unavailable');
      expect(unresolvedPackageRequires(text)).toEqual([]);
    }
  );
});
