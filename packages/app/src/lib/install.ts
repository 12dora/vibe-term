import { randomBytes } from 'node:crypto';
import { chmod, copyFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import type { InstallMeta } from '../types';
import { copyDirectory, ensureDir, pathExists, writeText } from './fs-utils';
import type { InstallLayout, PackageLayout } from './install-layout';
import { writeJsonFile } from './json-file';
import { DEFAULT_PEER_PORT, DEFAULT_STUN_SERVERS, type TmexRoleName } from './roles';

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

export interface AppEnvInput {
  host: string;
  port: number;
  databasePath: string;
  masterKey: string;
  role?: TmexRoleName;
  hubUrl?: string;
  peerPort?: number;
  hubPublicUrl?: string;
  stunServers?: string;
}

export function hubEnvDefaults(input?: {
  role?: TmexRoleName;
  hubUrl?: string;
  peerPort?: number;
  hubPublicUrl?: string;
  stunServers?: string;
}): Record<string, string> {
  const role = input?.role ?? 'standalone';
  return {
    TMEX_ROLES: role,
    TMEX_HUB_URL: input?.hubUrl ?? '',
    TMEX_PEER_PORT: String(input?.peerPort ?? DEFAULT_PEER_PORT),
    TMEX_HUB_PUBLIC_URL: input?.hubPublicUrl ?? '',
    TMEX_STUN_SERVERS: input?.stunServers ?? DEFAULT_STUN_SERVERS,
  };
}

export function buildAppEnvValues(input: AppEnvInput): Record<string, string> {
  return {
    NODE_ENV: 'production',
    TMEX_BIND_HOST: input.host,
    GATEWAY_PORT: String(input.port),
    DATABASE_URL: input.databasePath,
    TMEX_MASTER_KEY: input.masterKey,
    TMEX_BASE_URL: formatHttpEndpoint(input.host, input.port),
    TMEX_SITE_NAME: 'tmex',
    TMEX_DIRECT_ENABLED: 'true',
    ...hubEnvDefaults(input),
  };
}

export async function ensureInstallDir(installDir: string, force: boolean): Promise<void> {
  if (!(await pathExists(installDir))) {
    await ensureDir(installDir);
    return;
  }

  if (!force) {
    return;
  }

  await rm(installDir, { recursive: true, force: true });
  await ensureDir(installDir);
}

export async function deployRuntimeFiles(
  packageLayout: PackageLayout,
  installLayout: InstallLayout
): Promise<void> {
  await rm(installLayout.runtimeDir, { recursive: true, force: true });
  await rm(installLayout.feDir, { recursive: true, force: true });
  await rm(installLayout.drizzleDir, { recursive: true, force: true });

  await ensureDir(installLayout.runtimeDir);
  await ensureDir(installLayout.resourcesDir);

  await copyDirectory(packageLayout.runtimeDirPath, installLayout.runtimeDir);
  await copyDirectory(packageLayout.resourceFePath, installLayout.feDir);
  await copyDirectory(packageLayout.resourceDrizzlePath, installLayout.drizzleDir);
}

/** POSIX 单引号：`'` → `'\''`，使任意路径可安全插入 shell 脚本。 */
export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function writeRunScript(installLayout: InstallLayout, bunPath: string): Promise<void> {
  // 服务由 launchd/systemd 拉起时 PATH 极简，run.sh 显式补全。${HOME}/.bun/bin 由下方条件块
  // 动态补（故 extraPathDirs 排除它以免重复）；其余补 bun 实际目录 + homebrew/linuxbrew 兜底。
  const homeBunBin = join(homedir(), '.bun', 'bin');
  const bunDir = isAbsolute(bunPath) ? dirname(bunPath) : '';
  const extraPathDirs = [
    bunDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ].filter((dir, index, arr) => dir.length > 0 && dir !== homeBunBin && arr.indexOf(dir) === index);
  const pathExport =
    extraPathDirs.length > 0
      ? `export PATH=${extraPathDirs.map(quotePosixShellArg).join(':')}:"\${PATH:-}"`
      : 'export PATH="${PATH:-}"';
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"',
    'while IFS= read -r line || [[ -n "$line" ]]; do',
    '  line="${line%$\'\\r\'}"',
    '  [[ "$line" =~ ^[[:space:]]*$ ]] && continue',
    '  [[ "$line" =~ ^[[:space:]]*# ]] && continue',
    '  export "$line"',
    `done < ${quotePosixShellArg(installLayout.envPath)}`,
    '',
    'if [[ -n "${HOME:-}" ]] && [[ -d "${HOME}/.bun/bin" ]]; then',
    '  export PATH="${HOME}/.bun/bin:${PATH:-}"',
    'fi',
    pathExport,
    '',
    `export TMEX_FE_DIST_DIR=${quotePosixShellArg(installLayout.feDir)}`,
    `export TMEX_MIGRATIONS_DIR=${quotePosixShellArg(installLayout.drizzleDir)}`,
    `export TMEX_NATIVE_DIR=${quotePosixShellArg(installLayout.nativeDir)}`,
    '',
    `exec ${quotePosixShellArg(bunPath)} ${quotePosixShellArg(installLayout.runtimeServerPath)}`,
    '',
  ];
  const script = lines.join('\n');

  await writeText(installLayout.runScriptPath, script, 0o755);
  await chmod(installLayout.runScriptPath, 0o755);
}

export async function writeInstallMeta(
  installLayout: InstallLayout,
  meta: InstallMeta
): Promise<void> {
  await writeJsonFile(installLayout.metaPath, meta, 0o600);
}

export async function backupInstallArtifacts(
  installLayout: InstallLayout,
  backupDir: string
): Promise<void> {
  await ensureDir(backupDir);

  if (await pathExists(installLayout.runtimeDir)) {
    await copyDirectory(installLayout.runtimeDir, resolve(backupDir, 'runtime'));
  }

  if (await pathExists(installLayout.resourcesDir)) {
    await copyDirectory(installLayout.resourcesDir, resolve(backupDir, 'resources'));
  }

  if (await pathExists(installLayout.runScriptPath)) {
    await copyFile(installLayout.runScriptPath, resolve(backupDir, 'run.sh'));
  }

  if (await pathExists(installLayout.metaPath)) {
    await copyFile(installLayout.metaPath, resolve(backupDir, 'install-meta.json'));
  }

  if (await pathExists(installLayout.cliDir)) {
    await copyDirectory(installLayout.cliDir, resolve(backupDir, 'cli'));
  }
}

export async function restoreInstallArtifacts(
  installLayout: InstallLayout,
  backupDir: string
): Promise<void> {
  const runtimeBackup = resolve(backupDir, 'runtime');
  const resourcesBackup = resolve(backupDir, 'resources');
  const runScriptBackup = resolve(backupDir, 'run.sh');
  const metaBackup = resolve(backupDir, 'install-meta.json');
  const cliBackup = resolve(backupDir, 'cli');

  await rm(installLayout.runtimeDir, { recursive: true, force: true });
  await rm(installLayout.resourcesDir, { recursive: true, force: true });
  await rm(installLayout.cliDir, { recursive: true, force: true });

  if (await pathExists(runtimeBackup)) {
    await copyDirectory(runtimeBackup, installLayout.runtimeDir);
  }

  if (await pathExists(resourcesBackup)) {
    await copyDirectory(resourcesBackup, installLayout.resourcesDir);
  }

  if (await pathExists(runScriptBackup)) {
    await copyFile(runScriptBackup, installLayout.runScriptPath);
  }

  if (await pathExists(metaBackup)) {
    await copyFile(metaBackup, installLayout.metaPath);
  }

  if (await pathExists(cliBackup)) {
    await copyDirectory(cliBackup, installLayout.cliDir);
  }
}
