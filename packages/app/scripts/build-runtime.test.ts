import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeEntry, unresolvedPackageRequires } from './build-runtime';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cpu-features-'));
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

  test('splitting emits a chunks/ directory next to the entry', async () => {
    const dir = await tempDir();
    const heavy = join(dir, 'heavy.js');
    const entry = join(dir, 'entry.js');
    const outfile = join(dir, 'out.js');
    await writeFile(heavy, 'export const marker = "lazy-chunk";\n');
    await writeFile(entry, 'export async function loadHeavy() { return import("./heavy.js"); }\n');

    await buildRuntimeEntry({
      entrypoint: entry,
      outfile,
      version: '0.0.0-test',
    });

    const text = await readFile(outfile, 'utf8');
    expect(existsSync(outfile)).toBe(true);
    expect(text).toMatch(/chunks\//);
    const chunks = readdirSync(join(dir, 'chunks')).filter((name) => name.endsWith('.js'));
    expect(chunks.length).toBeGreaterThan(0);
    const heavyChunk = chunks.find((name) => name.startsWith('heavy-'));
    expect(heavyChunk).toBeDefined();
    const heavyText = await readFile(join(dir, 'chunks', heavyChunk as string), 'utf8');
    expect(heavyText).toContain('lazy-chunk');
  });

  test(
    'split runtime resolves ghostty wasm via parent assets after copy-runtime-assets layout',
    async () => {
      const dir = await tempDir();
      const runtimeDir = join(dir, 'runtime');
      await mkdir(runtimeDir, { recursive: true });
      const loaderPath = resolve(
        import.meta.dir,
        '../../ghostty-terminal/src/ghostty-wasm-loader.ts'
      );
      const wasmSrc = resolve(import.meta.dir, '../../ghostty-terminal/src/assets/ghostty-vt.wasm');
      expect(existsSync(loaderPath)).toBe(true);
      expect(existsSync(wasmSrc)).toBe(true);

      const entry = join(dir, 'entry.ts');
      await writeFile(
        entry,
        `export async function loadCandidates() {
  const mod = await import(${JSON.stringify(loaderPath)});
  return mod.ghosttyWasmCandidates();
}
`
      );
      const outfile = join(runtimeDir, 'server.js');
      await buildRuntimeEntry({
        entrypoint: entry,
        outfile,
        version: '0.0.0-test',
        splitting: true,
      });

      const assetsDir = join(runtimeDir, 'assets');
      await mkdir(assetsDir, { recursive: true });
      await copyFile(wasmSrc, join(assetsDir, 'ghostty-vt.wasm'));

      const { loadCandidates } = (await import(outfile)) as {
        loadCandidates: () => Promise<string[]>;
      };
      const candidates = await loadCandidates();
      const existing = candidates
        .map((source) => (source.startsWith('file://') ? fileURLToPath(source) : source))
        .filter((path) => existsSync(path));
      expect(
        existing.some((path) => path.endsWith(join('runtime', 'assets', 'ghostty-vt.wasm')))
      ).toBe(true);
    },
    { timeout: 20_000 }
  );

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
