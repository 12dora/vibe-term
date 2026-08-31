import { chmod, copyFile, lstat, readlink, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n';
import { ensureDir, pathExists, readText, writeText } from './fs-utils';
import { quotePosixShellArg } from './install';
import type { InstallLayout, PackageLayout } from './install-layout';

export const TMEX_SHIM_MARKER = '# tmex-cli shim; managed by tmex init/upgrade';
export const TMEX_INSTALL_DIR_PREFIX = '# tmex-install-dir:';

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
  skipWarning: string | null;
}

function buildShimScript(cliJsPath: string, bunPath: string, installDir: string): string {
  const quotedCli = quotePosixShellArg(cliJsPath);
  const quotedBun = quotePosixShellArg(bunPath);
  return [
    '#!/usr/bin/env bash',
    TMEX_SHIM_MARKER,
    `${TMEX_INSTALL_DIR_PREFIX} ${installDir}`,
    'set -euo pipefail',
    `CLI_JS=${quotedCli}`,
    'if command -v node >/dev/null 2>&1; then',
    '  NODE_VER="$(node --version 2>/dev/null || true)"',
    '  NODE_MAJOR="${NODE_VER#v}"',
    '  NODE_MAJOR="${NODE_MAJOR%%.*}"',
    '  case "$NODE_MAJOR" in',
    "    ''|*[!0-9]*) ;;",
    '    *)',
    '      if [ "$NODE_MAJOR" -ge 20 ]; then',
    '        exec node "$CLI_JS" "$@"',
    '      fi',
    '      ;;',
    '  esac',
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

function parseRecordedInstallDir(text: string): string | null {
  const line = text.split('\n').find((entry) => entry.startsWith(TMEX_INSTALL_DIR_PREFIX));
  if (!line) return null;
  const recorded = line.slice(TMEX_INSTALL_DIR_PREFIX.length).trim();
  return recorded || null;
}

async function readShimText(path: string): Promise<string> {
  return await readText(path).catch(() => '');
}

async function isManagedShim(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink() && !info.isFile()) {
      return false;
    }
    const text = await readShimText(path);
    return text.includes(TMEX_SHIM_MARKER);
  } catch {
    return false;
  }
}

async function shimMatchesInstall(path: string, installDir?: string): Promise<boolean> {
  if (!(await isManagedShim(path))) return false;
  if (installDir === undefined) return true;
  const recorded = parseRecordedInstallDir(await readShimText(path));
  return recorded === installDir;
}

async function canReplaceManagedPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
  } catch {
    return true;
  }
  return await isManagedShim(path);
}

async function writeShimAtomic(shimPath: string, content: string): Promise<void> {
  const tmpPath = `${shimPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeText(tmpPath, content, 0o755);
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, shimPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => null);
    throw error;
  }
}

function joinSkipWarnings(...parts: Array<string | null>): string | null {
  const warnings = parts.filter((part): part is string => Boolean(part));
  return warnings.length > 0 ? warnings.join('\n') : null;
}

function pathHintFor(
  localBinDir: string,
  bunBinDir: string,
  bunLinkPath: string | null,
  pathEnv: string
): string | null {
  if (isDirOnPath(localBinDir, pathEnv)) return null;
  if (bunLinkPath !== null && isDirOnPath(bunBinDir, pathEnv)) return null;
  return t('cli.shim.pathHint', { binDir: localBinDir });
}

async function installBunLink(
  shimPath: string,
  bunBinDir: string
): Promise<{ path: string | null; skipped: string | null }> {
  if (!(await pathExists(bunBinDir))) {
    return { path: null, skipped: null };
  }
  const linkPath = join(bunBinDir, 'tmex');
  if (!(await canReplaceManagedPath(linkPath))) {
    return { path: null, skipped: t('cli.shim.skipForeign', { path: linkPath }) };
  }
  const tmp = `${linkPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await symlink(shimPath, tmp);
    await rename(tmp, linkPath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => null);
    throw error;
  }
  return { path: linkPath, skipped: null };
}

export async function installTmexShim(
  options: InstallTmexShimOptions
): Promise<InstallTmexShimResult> {
  const localBinDir = options.localBinDir ?? defaultLocalBinDir();
  const bunBinDir = options.bunBinDir ?? defaultBunBinDir();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const cliJsPath = join(options.installLayout.installDir, 'current', 'cli', 'bin', 'tmex.js');
  const installDir = options.installLayout.installDir;

  await ensureDir(localBinDir);
  const shimPath = join(localBinDir, 'tmex');
  let skipWarning: string | null = null;

  if (await canReplaceManagedPath(shimPath)) {
    await writeShimAtomic(shimPath, buildShimScript(cliJsPath, options.bunPath, installDir));
    await chmod(shimPath, 0o755);
  } else {
    skipWarning = t('cli.shim.skipForeign', { path: shimPath });
    console.warn(`[tmex] ${skipWarning}`);
  }

  const bunLink =
    skipWarning === null
      ? await installBunLink(shimPath, bunBinDir)
      : { path: null as string | null, skipped: null as string | null };
  skipWarning = joinSkipWarnings(skipWarning, bunLink.skipped);
  if (bunLink.skipped) {
    console.warn(`[tmex] ${bunLink.skipped}`);
  }

  return {
    shimPath,
    bunLinkPath: bunLink.path,
    pathHint: pathHintFor(localBinDir, bunBinDir, bunLink.path, pathEnv),
    skipWarning,
  };
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
  installDir?: string;
}): Promise<void> {
  const localBinDir = options?.localBinDir ?? defaultLocalBinDir();
  const bunBinDir = options?.bunBinDir ?? defaultBunBinDir();
  const shimPath = join(localBinDir, 'tmex');
  const bunLinkPath = join(bunBinDir, 'tmex');
  const shouldRemoveShim = await shimMatchesInstall(shimPath, options?.installDir);

  try {
    const info = await lstat(bunLinkPath);
    const target = info.isSymbolicLink() ? await readlink(bunLinkPath).catch(() => '') : '';
    const bunIsOurs =
      (target === shimPath && shouldRemoveShim) ||
      (await shimMatchesInstall(bunLinkPath, options?.installDir));
    if (bunIsOurs) {
      await rm(bunLinkPath, { force: true });
    }
  } catch {
    // bun bin dir or link may not exist
  }

  if (shouldRemoveShim) {
    await rm(shimPath, { force: true });
  }
}
