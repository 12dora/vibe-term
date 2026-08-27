// 打包 runtime（内联 gateway），并在构建期注入 monorepo 版本号。
//
// 注入 TMEX_MONOREPO_VERSION 后，运行时 apps/gateway/src/system/version.ts 的
// typeof 守卫被短路，安装版/容器版无需再依赖 install-meta 或仓库 package.json 即可拿到版本。

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pkgRoot = resolve(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf8')) as {
  version?: string;
};
const version = pkg.version ?? '0.0.0';

console.log(`[build:runtime] injecting TMEX_MONOREPO_VERSION="${version}"`);

function runBunBuild(args: string[]): void {
  const build = spawnSync('bun', args, { cwd: pkgRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

runBunBuild([
  'build',
  'src/runtime/server.ts',
  '--outdir',
  './dist/runtime',
  '--target',
  'bun',
  '--format',
  'esm',
  '--external',
  'cpu-features',
  '--define',
  `TMEX_MONOREPO_VERSION="${version}"`,
]);

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

verifyVendoredNativeBundle();
verifyCryptoBundles();

const serverJs = join(pkgRoot, 'dist/runtime/server.js');
try {
  mkdirSync(join(pkgRoot, 'dist/runtime'), { recursive: true });
  console.log(`[build:runtime] server.js ${statSync(serverJs).size} bytes`);
} catch {
  console.warn('[build:runtime] server.js size unavailable');
}

const copy = spawnSync('bash', ['./scripts/copy-runtime-assets.sh'], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
if (copy.status !== 0) {
  process.exit(copy.status ?? 1);
}
