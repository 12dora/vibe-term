// 桥接发行资产：把 `vibeterm-cli-<v>.tgz` 重打成 `tmex-cli-<v>.tgz`。
//
// 为什么需要：≤1.1.40 的节点升级时按旧资产名下载、按精确文件名查 SHA256SUMS，
// 解包后硬校验 `package.json.name === 'tmex-cli'` 并 exec `package/bin/tmex.js`。
// 因此本版 release 同时上传两个资产，内容除 package.json 的 `name` 外完全一致。
// 全网升级到 ≥2.0 之后删掉本脚本与旧资产。
//
// 用法：bun scripts/release/build-legacy-asset.ts [vibeterm-cli-<v>.tgz]
//       （在 packages/app 下运行；不传参数时取目录内唯一的 vibeterm-cli-*.tgz）

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const LEGACY_PACKAGE_NAME = 'tmex-cli';

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`
    );
  }
}

function listFilesSorted(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => statSync(join(root, entry)).isFile())
    .sort();
}

/**
 * 解包 → 改 package.json 的 name → 重打包。归档成员按路径排序写入、gzip 不写时间戳
 * （`gzip -n`），因此产物的成员顺序稳定，不随文件系统遍历顺序变化。
 */
export function buildLegacyAsset(tarballPath: string): string {
  const source = resolve(tarballPath);
  const outDir = dirname(source);
  const work = mkdtempSync(join(tmpdir(), 'vibeterm-legacy-asset-'));

  try {
    run('tar', ['-xzf', source, '-C', work]);

    const pkgJsonPath = join(work, 'package', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      name?: string;
      version?: string;
      bin?: Record<string, string>;
    };
    if (!pkg.version) throw new Error(`${source}: package.json has no version`);
    if (!pkg.bin?.tmex) throw new Error(`${source}: package.json is missing bin.tmex`);
    pkg.name = LEGACY_PACKAGE_NAME;
    writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const fileList = join(work, 'files.txt');
    const files = listFilesSorted(join(work, 'package')).map((name) => `package/${name}`);
    writeFileSync(fileList, `${files.join('\n')}\n`);

    const tarPath = join(work, 'legacy.tar');
    run('tar', ['-cf', tarPath, '-C', work, '-T', fileList]);

    const outPath = join(outDir, `${LEGACY_PACKAGE_NAME}-${pkg.version}.tgz`);
    const gzip = spawnSync('gzip', ['-n', '-9', '-c', tarPath], { maxBuffer: 512 * 1024 * 1024 });
    if (gzip.status !== 0) {
      throw new Error(`gzip failed: ${gzip.stderr?.toString() || gzip.status}`);
    }
    writeFileSync(outPath, gzip.stdout);
    return outPath;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function resolveInput(argv: string[]): string {
  const explicit = argv[0];
  if (explicit) return explicit;
  const candidates = readdirSync(process.cwd()).filter(
    (name) => name.startsWith('vibeterm-cli-') && name.endsWith('.tgz')
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one vibeterm-cli-*.tgz in ${process.cwd()}, found ${candidates.length}`
    );
  }
  return candidates[0];
}

if (import.meta.main) {
  const input = resolveInput(process.argv.slice(2));
  const out = buildLegacyAsset(input);
  console.log(`[build-legacy-asset] ${basename(input)} -> ${basename(out)}`);
}
