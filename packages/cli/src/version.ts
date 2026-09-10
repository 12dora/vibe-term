// CLI 自报版本。网关的 canonical v1.1 版本门是 fail-closed 的：报不出版本就连不上 WS，
// 所以这里必须找到 monorepo 的发布版本号（= vibeterm-cli 的版本），不能用本包的 0.1.0。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 构建期注入（packages/app 打包时可 define）。未注入时为 undefined，用 typeof 守卫。
declare const VIBETERM_MONOREPO_VERSION: string | undefined;

/** 发布包的名字；`../package.json` 命中其一即认为拿到了 monorepo 版本。 */
const RELEASE_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  'vibeterm-cli',
  'vibeterm',
  'tmex-cli',
  'tmex',
]);

/**
 * 四种布局都要能找到版本：
 *   installed  `<installDir>/current/cli/dist/cli.js` → `../package.json`（vibeterm-cli）
 *   packaged   `packages/app/dist/cli.js`            → `../package.json`（vibeterm-cli）
 *   dev bundle `packages/cli/dist/cli.js`            → `../../app/package.json`
 *   dev source `packages/cli/src/main.ts`            → `../../app/package.json`
 */
const CANDIDATES = ['../package.json', '../../app/package.json'] as const;

function readPackage(path: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
  } catch {
    return null;
  }
}

function versionFromPackages(moduleDir: string): string | null {
  let fallback: string | null = null;
  for (const candidate of CANDIDATES) {
    const pkg = readPackage(resolve(moduleDir, candidate));
    if (!pkg?.version) continue;
    if (pkg.name && RELEASE_PACKAGE_NAMES.has(pkg.name)) return pkg.version;
    fallback ??= pkg.version;
  }
  return fallback;
}

let cached: string | null = null;

export function cliVersion(): string {
  if (cached) return cached;
  const injected =
    typeof VIBETERM_MONOREPO_VERSION === 'string' && VIBETERM_MONOREPO_VERSION
      ? VIBETERM_MONOREPO_VERSION
      : null;
  const fromEnv = process.env.VIBETERM_CLI_VERSION?.trim() || null;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  cached = fromEnv ?? injected ?? versionFromPackages(moduleDir) ?? 'unknown';
  return cached;
}
