/**
 * Managed standalone Gateway 编译入口。
 *
 * 固定 target matrix：darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64。
 * 仅当前宿主三元组真实 `bun build --compile`；其余目标只输出定义，不假装 PASS。
 *
 * 用法：
 *   bun scripts/build-managed.ts
 *   bun scripts/build-managed.ts --target bun-darwin-arm64
 *   bun scripts/build-managed.ts --out-dir /path/to/out
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MANAGED_TARGETS = [
  'bun-darwin-arm64',
  'bun-darwin-x64',
  'bun-linux-arm64',
  'bun-linux-x64',
] as const;

export type ManagedTarget = (typeof MANAGED_TARGETS)[number];

const gatewayRoot = resolve(import.meta.dir, '..');
const appPkgPath = resolve(gatewayRoot, '../../packages/app/package.json');
const entry = resolve(gatewayRoot, 'src/managed-entry.ts');
const drizzleRoot = resolve(gatewayRoot, 'drizzle');

function managedAssetEntrypoints(): string[] {
  const migrations = readdirSync(drizzleRoot)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(drizzleRoot, name));
  return migrations;
}

function hostTarget(): ManagedTarget {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin' && arch === 'arm64') return 'bun-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'bun-darwin-x64';
  if (platform === 'linux' && arch === 'arm64') return 'bun-linux-arm64';
  if (platform === 'linux' && arch === 'x64') return 'bun-linux-x64';
  throw new Error(`unsupported host for managed compile: ${platform}/${arch}`);
}

function parseArgs(argv: string[]): { targets: ManagedTarget[]; outDir: string } {
  let outDir = resolve(gatewayRoot, 'dist-managed');
  const requested: ManagedTarget[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-dir' && argv[i + 1]) {
      i += 1;
      outDir = resolve(argv[i] as string);
    } else if (a === '--target' && argv[i + 1]) {
      i += 1;
      const t = argv[i] as ManagedTarget;
      if (!(MANAGED_TARGETS as readonly string[]).includes(t)) {
        throw new Error(`unknown target ${t}; expected one of ${MANAGED_TARGETS.join(', ')}`);
      }
      requested.push(t);
    } else if (a === '--all-defined') {
      // matrix definition only; compile still host-only unless --target/--compile-all
    } else if (a === '--compile-all') {
      requested.push(...MANAGED_TARGETS);
    }
  }
  if (requested.length === 0) {
    requested.push(hostTarget());
  }
  return { targets: requested, outDir };
}

function readVersion(): string {
  try {
    return (
      (JSON.parse(readFileSync(appPkgPath, 'utf8')) as { version?: string }).version ?? '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

function outfileName(target: ManagedTarget): string {
  const suffix = target.replace(/^bun-/, '');
  return process.platform === 'win32'
    ? `tmex-gateway-managed-${suffix}.exe`
    : `tmex-gateway-managed-${suffix}`;
}

export interface TargetResult {
  target: ManagedTarget;
  status: 'compiled' | 'defined_not_executed' | 'failed';
  outfile?: string;
  sha256?: string;
  sizeBytes?: number;
  error?: string;
  hostMatch: boolean;
}

function compileOne(target: ManagedTarget, outDir: string, version: string): TargetResult {
  const host = hostTarget();
  const hostMatch = target === host;
  const outfile = join(outDir, outfileName(target));

  // 非当前宿主：默认只记 matrix，不假装 cross-compile PASS（Bun 可跨编译但本 Spike 要求诚实）。
  if (!hostMatch && !process.env.TMEX_MANAGED_FORCE_CROSS) {
    return {
      target,
      status: 'defined_not_executed',
      hostMatch: false,
    };
  }

  const args = [
    'build',
    entry,
    ...managedAssetEntrypoints(),
    '--compile',
    `--outfile=${outfile}`,
    `--target=${target}`,
    '--define',
    `TMEX_MONOREPO_VERSION="${version}"`,
    '--define',
    'TMEX_MANAGED_BUILD=true',
    // ssh2 的 optional native dep cpu-features 在多数宿主未安装源码；
    // ssh2 运行时不强制 require 它，external 让 compile 跳过打包而非报错。
    '--external',
    'cpu-features',
  ];

  console.log(`[build-managed] compiling ${target} → ${outfile}`);
  const r = spawnSync('bun', args, { cwd: gatewayRoot, stdio: 'inherit', env: process.env });
  if ((r.status ?? 1) !== 0 || !existsSync(outfile)) {
    return {
      target,
      status: 'failed',
      outfile,
      hostMatch,
      error: `bun build --compile failed with status ${r.status}`,
    };
  }

  const buf = readFileSync(outfile);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return {
    target,
    status: 'compiled',
    outfile,
    sha256,
    sizeBytes: buf.length,
    hostMatch,
  };
}

function main(): void {
  const { targets, outDir } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const version = readVersion();
  const host = hostTarget();

  const results: TargetResult[] = [];
  // 始终写出完整 matrix 定义；仅请求的 target 尝试编译。
  for (const t of MANAGED_TARGETS) {
    if (targets.includes(t)) {
      results.push(compileOne(t, outDir, version));
    } else {
      results.push({ target: t, status: 'defined_not_executed', hostMatch: t === host });
    }
  }

  const matrixPath = join(outDir, 'target-matrix.json');
  const matrix = {
    schemaVersion: 1,
    bunVersion: Bun.version,
    host: { platform: process.platform, arch: process.arch, target: host },
    monorepoVersion: version,
    entry: 'src/managed-entry.ts',
    targets: results,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  console.log(`[build-managed] wrote ${matrixPath}`);

  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    process.exit(1);
  }

  const compiled = results.filter((r) => r.status === 'compiled');
  if (compiled.length === 0) {
    console.error('[build-managed] no target compiled');
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
