import { chmod, copyFile, lstat, readlink, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { t } from '../i18n';
import { ensureDir, pathExists, readText, writeText } from './fs-utils';
import { quotePosixShellArg } from './install';
import type { InstallLayout, PackageLayout } from './install-layout';
import { readJsonFile } from './json-file';

export const VIBETERM_SHIM_MARKER = '# vibeterm-cli shim; managed by vibeterm init/upgrade';
export const VIBETERM_INSTALL_DIR_PREFIX = '# vibeterm-install-dir:';

/** 改名前写出的 shim 标记；覆盖 / 删除判定必须继续认，否则老 shim 会被当成外来文件跳过。 */
export const LEGACY_SHIM_MARKER = '# tmex-cli shim; managed by tmex init/upgrade';
export const LEGACY_INSTALL_DIR_PREFIX = '# tmex-install-dir:';

/** 主命令在前，别名在后；别名 shim 内容与主命令完全一致，只是文件名不同。 */
const SHIM_NAMES = ['vibeterm', 'tmex'] as const;

const CLI_BIN_FILES = ['vibeterm.js', 'tmex.js'] as const;

/** `[localBinDir, bunBinDir]`：shim 与 bun 软链的落点，永远显式传递。 */
export type ShimDirs = [localBinDir: string, bunBinDir: string];

/**
 * 真实用户主目录下的 shim 目录。只允许在用户主动触发的入口（init / upgrade / uninstall /
 * doctor）里调用：库内部一律接收调用方注入的目录，避免测试写穿真实 `~/.local/bin`。
 */
export function defaultShimDirs(): ShimDirs {
  return [join(homedir(), '.local', 'bin'), join(homedir(), '.bun', 'bin')];
}

export function isDirOnPath(dir: string, pathEnv: string = process.env.PATH ?? ''): boolean {
  const needle = dir.replace(/\/+$/, '');
  return pathEnv.split(':').some((entry) => entry.replace(/\/+$/, '') === needle);
}

/**
 * 两个 bin 都部署到 `current/cli/bin/`：新 shim 走 `vibeterm.js`，旧 shim 与旧 gateway
 * 推包路径走 `tmex.js`。若包里只有旧 bin（从 legacy 资产驱动 apply），用它补出新名。
 */
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

  const binDir = join(packageLayout.packageRoot, 'bin');
  const present = new Set<string>();
  for (const name of CLI_BIN_FILES) {
    if (await pathExists(join(binDir, name))) present.add(name);
  }
  if (present.size === 0) {
    throw new Error(`cli package has no bin: ${binDir}`);
  }
  // 只有 ≤1.1.40 的包会缺 `vibeterm.js`（那时 `tmex.js` 是完整入口，拿来补名安全）；
  // 2.0 起两个 bin 一起随包发布，`tmex.js` 是 `vibeterm.js` 的转发。
  const fallback = present.has('vibeterm.js') ? 'vibeterm.js' : 'tmex.js';
  for (const name of CLI_BIN_FILES) {
    await copyFile(
      join(binDir, present.has(name) ? name : fallback),
      join(installLayout.cliDir, 'bin', name)
    );
  }

  await copyFile(packageLayout.cliDistPath, join(installLayout.cliDir, 'dist', 'cli-node.js'));
}

export interface InstallVibeTermShimOptions {
  installLayout: InstallLayout;
  bunPath: string;
  localBinDir: string;
  bunBinDir: string;
  pathEnv?: string;
  /**
   * 只有显式 --replace-shim 才允许接管其他安装或归属未知的托管 shim。
   */
  force?: boolean;
}

export interface InstallVibeTermShimResult {
  shimDeployed: boolean;
  shimPath: string;
  aliasShimPath: string;
  bunLinkPath: string | null;
  aliasBunLinkPath: string | null;
  pathHint: string | null;
  skipWarning: string | null;
}

/**
 * 入口在运行时解析：回滚到 1.x 版本目录后 `current/cli/bin/` 里只有 `tmex.js`，
 * shim 若把新名写死就会连 `upgrade --repair` 都跑不起来。
 */
function buildShimScript(
  cliJsPath: string,
  legacyCliJsPath: string,
  bunPath: string,
  installDir: string
): string {
  const quotedCli = quotePosixShellArg(cliJsPath);
  const quotedLegacyCli = quotePosixShellArg(legacyCliJsPath);
  const quotedBun = quotePosixShellArg(bunPath);
  return [
    '#!/usr/bin/env bash',
    VIBETERM_SHIM_MARKER,
    `${VIBETERM_INSTALL_DIR_PREFIX} ${installDir}`,
    'set -euo pipefail',
    `CLI_JS=${quotedCli}`,
    `CLI_JS_LEGACY=${quotedLegacyCli}`,
    'if [ ! -f "$CLI_JS" ]; then',
    '  if [ -f "$CLI_JS_LEGACY" ]; then',
    '    CLI_JS="$CLI_JS_LEGACY"',
    '  else',
    '    echo "vibeterm: cli entry not found: $CLI_JS" >&2',
    '    exit 127',
    '  fi',
    'fi',
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
    'echo "vibeterm: node or bun is required" >&2',
    'exit 127',
    '',
  ].join('\n');
}

function parseRecordedInstallDir(text: string): string | null {
  const lines = text.split('\n');
  for (const prefix of [VIBETERM_INSTALL_DIR_PREFIX, LEGACY_INSTALL_DIR_PREFIX]) {
    const line = lines.find((entry) => entry.startsWith(prefix));
    if (!line) continue;
    const recorded = line.slice(prefix.length).trim();
    if (recorded) return recorded;
  }
  return null;
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
    return text.includes(VIBETERM_SHIM_MARKER) || text.includes(LEGACY_SHIM_MARKER);
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

async function resolveRecordedInstallDir(recorded: string): Promise<string> {
  const original = resolve(recorded);
  if (basename(original) !== 'tmex' || (await pathExists(original))) return original;
  const migrated = join(dirname(original), 'vibeterm');
  const meta = await readJsonFile<{ installDir?: string; cliVersion?: string } | null>(
    join(migrated, 'install-meta.json')
  ).catch(() => null);
  if (typeof meta?.cliVersion === 'string' && meta.cliVersion.trim()) return migrated;
  return original;
}

async function shimReplacementWarning(
  path: string,
  installDir: string,
  force?: boolean
): Promise<string | null> {
  try {
    await lstat(path);
  } catch {
    return null;
  }
  if (!(await isManagedShim(path))) return t('cli.shim.skipForeign', { path });
  if (force) return null;
  const recorded = parseRecordedInstallDir(await readShimText(path));
  if (!recorded) return t('cli.shim.skipUnknown', { path });
  const owner = await resolveRecordedInstallDir(recorded);
  if (owner === resolve(installDir) || !(await pathExists(owner))) return null;
  return t('cli.shim.skipOwned', { installDir: owner });
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
  bunBinDir: string,
  linkName: string,
  guard: { installDir: string; force?: boolean }
): Promise<{ path: string | null; skipped: string | null }> {
  if (!(await pathExists(bunBinDir))) {
    return { path: null, skipped: null };
  }
  const linkPath = join(bunBinDir, linkName);
  const warning = await shimReplacementWarning(linkPath, guard.installDir, guard.force);
  if (warning) return { path: null, skipped: warning };
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

export async function installVibeTermShim(
  options: InstallVibeTermShimOptions
): Promise<InstallVibeTermShimResult> {
  const { localBinDir, bunBinDir } = options;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const cliBinDir = join(options.installLayout.installDir, 'current', 'cli', 'bin');
  const installDir = options.installLayout.installDir;
  const content = buildShimScript(
    join(cliBinDir, CLI_BIN_FILES[0]),
    join(cliBinDir, CLI_BIN_FILES[1]),
    options.bunPath,
    installDir
  );

  for (const name of SHIM_NAMES) {
    const warning = await shimReplacementWarning(
      join(localBinDir, name),
      installDir,
      options.force
    );
    if (!warning) continue;
    console.warn(`[vibeterm] ${warning}`);
    return {
      shimDeployed: false,
      shimPath: join(localBinDir, SHIM_NAMES[0]),
      aliasShimPath: join(localBinDir, SHIM_NAMES[1]),
      bunLinkPath: null,
      aliasBunLinkPath: null,
      pathHint: null,
      skipWarning: warning,
    };
  }

  await ensureDir(localBinDir);
  const written: Array<{ name: string; path: string }> = [];
  const warnings: Array<string | null> = [];
  for (const name of SHIM_NAMES) {
    const path = join(localBinDir, name);
    await writeShimAtomic(path, content);
    written.push({ name, path });
  }

  const bunLinks = new Map<string, string | null>();
  for (const entry of written) {
    const link = await installBunLink(entry.path, bunBinDir, entry.name, {
      installDir,
      force: options.force,
    });
    bunLinks.set(entry.name, link.path);
    if (link.skipped) {
      warnings.push(link.skipped);
      console.warn(`[vibeterm] ${link.skipped}`);
    }
  }

  const shimPath = join(localBinDir, SHIM_NAMES[0]);
  const bunLinkPath = bunLinks.get(SHIM_NAMES[0]) ?? null;

  return {
    shimDeployed: true,
    shimPath,
    aliasShimPath: join(localBinDir, SHIM_NAMES[1]),
    bunLinkPath,
    aliasBunLinkPath: bunLinks.get(SHIM_NAMES[1]) ?? null,
    pathHint: pathHintFor(localBinDir, bunBinDir, bunLinkPath, pathEnv),
    skipWarning: joinSkipWarnings(...warnings),
  };
}

export async function deployCliAndShim(
  packageLayout: PackageLayout,
  installLayout: InstallLayout,
  bunPath: string,
  options: Omit<InstallVibeTermShimOptions, 'installLayout' | 'bunPath'>
): Promise<InstallVibeTermShimResult> {
  await deployCliPackage(packageLayout, installLayout);
  return await installVibeTermShim({
    installLayout,
    bunPath,
    ...options,
  });
}

async function removeOneShim(
  shimPath: string,
  bunLinkPath: string,
  installDir?: string
): Promise<void> {
  const shouldRemoveShim = await shimMatchesInstall(shimPath, installDir);

  try {
    const info = await lstat(bunLinkPath);
    const target = info.isSymbolicLink() ? await readlink(bunLinkPath).catch(() => '') : '';
    const bunIsOurs =
      (target === shimPath && shouldRemoveShim) ||
      (await shimMatchesInstall(bunLinkPath, installDir));
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

export async function removeVibeTermShims(options: {
  localBinDir: string;
  bunBinDir: string;
  installDir?: string;
}): Promise<void> {
  const { localBinDir, bunBinDir } = options;
  for (const name of SHIM_NAMES) {
    await removeOneShim(join(localBinDir, name), join(bunBinDir, name), options.installDir);
  }
}

/** doctor 用：找出仍带改名前标记的 shim（升级后正常应全部被重写）。 */
export async function findLegacyMarkedShims(options: {
  localBinDir: string;
  bunBinDir: string;
}): Promise<string[]> {
  const dirs = [options.localBinDir, options.bunBinDir];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of SHIM_NAMES) {
      const path = join(dir, name);
      if (!(await pathExists(path))) continue;
      const text = await readShimText(path);
      if (text.includes(LEGACY_SHIM_MARKER) && !text.includes(VIBETERM_SHIM_MARKER)) {
        found.push(path);
      }
    }
  }
  return found;
}
