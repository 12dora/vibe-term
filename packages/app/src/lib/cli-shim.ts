import { chmod, copyFile, lstat, readlink, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n';
import { ensureDir, pathExists, readText, writeText } from './fs-utils';
import { quotePosixShellArg } from './install';
import type { InstallLayout, PackageLayout } from './install-layout';

export const TMEX_SHIM_MARKER = '# tmex-cli shim; managed by tmex init/upgrade';

export function defaultLocalBinDir(): string {
  return join(homedir(), '.local', 'bin');
}

export function defaultBunBinDir(): string {
  return join(homedir(), '.bun', 'bin');
}

export function isDirOnPath(dir: string, pathEnv: string = process.env.PATH ?? ''): boolean {
  const needle = dir.replace(/\/+$/, '');
  return pathEnv.split(':').some((entry) => entry.replace(/\/+$/, '') === needle);
}

export async function deployCliPackage(
  packageLayout: PackageLayout,
  installLayout: InstallLayout
): Promise<void> {
  await rm(installLayout.cliDir, { recursive: true, force: true });
  await ensureDir(join(installLayout.cliDir, 'bin'));
  await ensureDir(join(installLayout.cliDir, 'dist'));
  await copyFile(
    join(packageLayout.packageRoot, 'package.json'),
    join(installLayout.cliDir, 'package.json')
  );
  await copyFile(
    join(packageLayout.packageRoot, 'bin', 'tmex.js'),
    join(installLayout.cliDir, 'bin', 'tmex.js')
  );
  await copyFile(packageLayout.cliDistPath, join(installLayout.cliDir, 'dist', 'cli-node.js'));
}

export interface InstallTmexShimOptions {
  installLayout: InstallLayout;
  bunPath: string;
  localBinDir?: string;
  bunBinDir?: string;
  pathEnv?: string;
}

export interface InstallTmexShimResult {
  shimPath: string;
  bunLinkPath: string | null;
  pathHint: string | null;
}

function buildShimScript(cliJsPath: string, bunPath: string): string {
  const quotedCli = quotePosixShellArg(cliJsPath);
  const quotedBun = quotePosixShellArg(bunPath);
  return [
    '#!/usr/bin/env bash',
    TMEX_SHIM_MARKER,
    'set -euo pipefail',
    `CLI_JS=${quotedCli}`,
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$CLI_JS" "$@"',
    'fi',
    `BUN_PATH=${quotedBun}`,
    'if [[ -n "$BUN_PATH" && -x "$BUN_PATH" ]]; then',
    '  exec "$BUN_PATH" "$CLI_JS" "$@"',
    'fi',
    'if command -v bun >/dev/null 2>&1; then',
    '  exec bun "$CLI_JS" "$@"',
    'fi',
    'echo "tmex: node or bun is required" >&2',
    'exit 127',
    '',
  ].join('\n');
}

async function isManagedShim(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const text = await readText(path).catch(() => '');
      return text.includes(TMEX_SHIM_MARKER);
    }
    if (!info.isFile()) {
      return false;
    }
    const text = await readText(path);
    return text.includes(TMEX_SHIM_MARKER);
  } catch {
    return false;
  }
}

export async function installTmexShim(
  options: InstallTmexShimOptions
): Promise<InstallTmexShimResult> {
  const localBinDir = options.localBinDir ?? defaultLocalBinDir();
  const bunBinDir = options.bunBinDir ?? defaultBunBinDir();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const cliJsPath = join(options.installLayout.cliDir, 'bin', 'tmex.js');

  await ensureDir(localBinDir);
  const shimPath = join(localBinDir, 'tmex');
  await writeText(shimPath, buildShimScript(cliJsPath, options.bunPath), 0o755);
  await chmod(shimPath, 0o755);

  let bunLinkPath: string | null = null;
  if (await pathExists(bunBinDir)) {
    const linkPath = join(bunBinDir, 'tmex');
    await rm(linkPath, { force: true });
    await symlink(shimPath, linkPath);
    bunLinkPath = linkPath;
  }

  const pathHint = isDirOnPath(localBinDir, pathEnv)
    ? null
    : t('cli.shim.pathHint', { binDir: localBinDir });

  return { shimPath, bunLinkPath, pathHint };
}

export async function deployCliAndShim(
  packageLayout: PackageLayout,
  installLayout: InstallLayout,
  bunPath: string,
  options?: Omit<InstallTmexShimOptions, 'installLayout' | 'bunPath'>
): Promise<InstallTmexShimResult> {
  await deployCliPackage(packageLayout, installLayout);
  return await installTmexShim({
    installLayout,
    bunPath,
    ...options,
  });
}

export async function removeTmexShims(options?: {
  localBinDir?: string;
  bunBinDir?: string;
}): Promise<void> {
  const localBinDir = options?.localBinDir ?? defaultLocalBinDir();
  const bunBinDir = options?.bunBinDir ?? defaultBunBinDir();
  const shimPath = join(localBinDir, 'tmex');
  const bunLinkPath = join(bunBinDir, 'tmex');

  if (await isManagedShim(shimPath)) {
    await rm(shimPath, { force: true });
  }

  try {
    const info = await lstat(bunLinkPath);
    if (info.isSymbolicLink()) {
      const target = await readlink(bunLinkPath).catch(() => '');
      if (target === shimPath || (await isManagedShim(bunLinkPath))) {
        await rm(bunLinkPath, { force: true });
      }
    } else if (await isManagedShim(bunLinkPath)) {
      await rm(bunLinkPath, { force: true });
    }
  } catch {
    // bun bin dir or link may not exist
  }
}
