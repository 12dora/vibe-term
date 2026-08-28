// 打包 runtime（内联 gateway），并在构建期注入 monorepo 版本号。
//
// 注入 TMEX_MONOREPO_VERSION 后，运行时 apps/gateway/src/system/version.ts 的
// typeof 守卫被短路，安装版/容器版无需再依赖 install-meta 或仓库 package.json 即可拿到版本。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

const pkgRoot = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  version?: string;
};
const version = pkg.version ?? '0.0.0';

// ssh2 对 cpu-features 是 try/catch 的可选 native；--external 会在无 node_modules 的
// 安装布局里触发 Bun auto-install，首启可能卡数分钟。打成抛错的虚拟模块即可。
export const cpuFeaturesStubPlugin: BunPlugin = {
  name: 'stub-cpu-features',
  setup(build) {
    build.onResolve({ filter: /^cpu-features$/ }, () => ({
      path: 'cpu-features',
      namespace: 'tmex-optional-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'tmex-optional-stub' }, () => ({
      contents: "throw new Error('cpu-features unavailable');\n",
      loader: 'js',
    }));
  },
};

const BARE_REQUIRE_RE = /(?:^|[^.\w$])(?:__)?require\(\s*["']([^"']+)["']\s*\)/g;

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith('node:') ? [name, name.slice('node:'.length)] : [name, `node:${name}`]
  )
);

export function collectBareRequires(bundleText: string): string[] {
  const found = new Set<string>();
  for (const match of bundleText.matchAll(BARE_REQUIRE_RE)) {
    const specifier = match[1];
    if (specifier) {
      found.add(specifier);
    }
  }
  return [...found].sort();
}

export function unresolvedPackageRequires(bundleText: string): string[] {
  return collectBareRequires(bundleText).filter((specifier) => {
    if (specifier.startsWith('node:') || specifier.startsWith('bun:')) {
      return false;
    }
    return !NODE_BUILTINS.has(specifier);
  });
}

export async function buildRuntimeEntry(options: {
  entrypoint: string;
  outfile: string;
  version: string;
}): Promise<void> {
  const result = await Bun.build({
    entrypoints: [options.entrypoint],
    outdir: dirname(options.outfile),
    naming: basename(options.outfile),
    target: 'bun',
    format: 'esm',
    plugins: [cpuFeaturesStubPlugin],
    define: {
      TMEX_MONOREPO_VERSION: JSON.stringify(options.version),
    },
    throw: false,
  });
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`bun build failed for ${options.entrypoint}`);
  }
  for (const log of result.logs) {
    console.log(String(log));
  }
}

function runBunBuild(args: string[]): void {
  const build = spawnSync('bun', args, { cwd: pkgRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

function verifyVendoredNativeBundle(): void {
  const workDir = mkdtempSync(join(tmpdir(), 'tmex-native-bundle-'));
  try {
    const outfile = join(workDir, 'native-datachannel.js');
    runBunBuild([
      'build',
      'src/lib/native-datachannel.ts',
      '--outfile',
      outfile,
      '--target',
      'bun',
      '--format',
      'esm',
      '--packages',
      'bundle',
    ]);
    const text = readFileSync(outfile, 'utf8');
    if (
      /require\(["']@node-datachannel\//.test(text) ||
      /from ["']detect-libc["']/.test(text) ||
      /require\(["']detect-libc["']\)/.test(text)
    ) {
      console.error(
        '[build:runtime] vendored native JS still references platform packages or detect-libc'
      );
      process.exit(1);
    }
    if (!text.includes('TMEX_NATIVE_DIR') || !text.includes('node_datachannel.node')) {
      console.error('[build:runtime] vendored native JS is missing absolute-path loader');
      process.exit(1);
    }
    const bytes = statSync(outfile).size;
    console.log(
      `[build:runtime] vendored node-datachannel JS bundle ${bytes} bytes (inlined, not shipped separately)`
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function verifyCryptoBundles(): void {
  const workDir = mkdtempSync(join(tmpdir(), 'tmex-crypto-bundle-'));
  const entry = join(pkgRoot, 'scripts', '.crypto-smoke.ts');
  try {
    writeFileSync(
      entry,
      `import { argon2id } from '../../shared/node_modules/hash-wasm';
import { ed25519, x25519 } from '../../shared/node_modules/@noble/curves/ed25519.js';
import { hkdf } from '../../shared/node_modules/@noble/hashes/hkdf.js';
import { sha256 } from '../../shared/node_modules/@noble/hashes/sha2.js';
export { argon2id, ed25519, x25519, hkdf, sha256 };
`
    );
    const outfile = join(workDir, 'crypto.js');
    const build = spawnSync(
      'bun',
      [
        'build',
        entry,
        '--outfile',
        outfile,
        '--target',
        'bun',
        '--format',
        'esm',
        '--packages',
        'bundle',
      ],
      { cwd: resolve(pkgRoot, '../shared'), stdio: 'pipe', encoding: 'utf8' }
    );
    if (build.status !== 0) {
      console.warn(
        '[build:runtime] hash-wasm/@noble bundle smoke skipped:',
        (build.stderr || build.stdout).trim()
      );
      return;
    }
    const bytes = statSync(outfile).size;
    const text = readFileSync(outfile, 'utf8');
    const hasWasmJson = text.includes('wasm') || text.includes('WebAssembly');
    console.log(
      `[build:runtime] hash-wasm/@noble smoke bundle ${bytes} bytes wasmEmbedded=${hasWasmJson}`
    );
  } finally {
    rmSync(entry, { force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
}

function assertNoUnresolvedPackageRequires(filePath: string): void {
  const text = readFileSync(filePath, 'utf8');
  const unresolved = unresolvedPackageRequires(text);
  if (unresolved.length > 0) {
    console.error(
      `[build:runtime] unresolved package requires in ${filePath}: ${unresolved.join(', ')}`
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(`[build:runtime] injecting TMEX_MONOREPO_VERSION="${version}"`);

  mkdirSync(join(pkgRoot, 'dist/runtime'), { recursive: true });

  const serverJs = join(pkgRoot, 'dist/runtime/server.js');
  const cliAuthJs = join(pkgRoot, 'dist/runtime/cli-auth.js');

  await buildRuntimeEntry({
    entrypoint: join(pkgRoot, 'src/runtime/server.ts'),
    outfile: serverJs,
    version,
  });
  await buildRuntimeEntry({
    entrypoint: join(pkgRoot, 'src/cli-auth-entry.ts'),
    outfile: cliAuthJs,
    version,
  });

  verifyVendoredNativeBundle();
  verifyCryptoBundles();

  assertNoUnresolvedPackageRequires(serverJs);
  assertNoUnresolvedPackageRequires(cliAuthJs);

  try {
    console.log(`[build:runtime] server.js ${statSync(serverJs).size} bytes`);
    console.log(`[build:runtime] cli-auth.js ${statSync(cliAuthJs).size} bytes`);
  } catch {
    console.warn('[build:runtime] runtime bundle size unavailable');
  }

  const copy = spawnSync('bash', ['./scripts/copy-runtime-assets.sh'], {
    cwd: pkgRoot,
    stdio: 'inherit',
  });
  if (copy.status !== 0) {
    process.exit(copy.status ?? 1);
  }
}

if (import.meta.main) {
  await main();
}
