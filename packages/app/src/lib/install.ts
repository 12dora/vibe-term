import { randomBytes } from 'node:crypto';
import { chmod, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { formatHttpEndpoint } from '../../../shared/src/network';
import type { InstallMeta } from '../types';
import { copyDirectory, ensureDir, pathExists, readText, writeTextAtomic } from './fs-utils';
import { type InstallLayout, type PackageLayout, currentRuntimePaths } from './install-layout';
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
  relayPublicUrl?: string;
  relayAdminToken?: string;
  stunServers?: string;
}

const HUB_PEER_ID_RE = /^[0-9a-f]{32}$/;

export function parseHubPeerIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const id = part.trim().toLowerCase();
    if (!id || !HUB_PEER_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function applyHubModeEnvKeys(
  env: Record<string, string>,
  patch: {
    roles?: string;
    mode?: string;
    publicUrl?: string;
    priority?: number | string;
    writerEpoch?: number | string;
    hubPeers?: string | readonly string[];
  }
): Record<string, string> {
  const next = { ...env };
  if (patch.roles !== undefined) next.TMEX_ROLES = patch.roles;
  if (patch.mode !== undefined) next.TMEX_HUB_MODE = patch.mode;
  if (patch.publicUrl !== undefined) next.TMEX_HUB_PUBLIC_URL = patch.publicUrl;
  if (patch.priority !== undefined) next.TMEX_HUB_PRIORITY = String(patch.priority);
  if (patch.writerEpoch !== undefined) next.TMEX_HUB_WRITER_EPOCH = String(patch.writerEpoch);
  if (patch.hubPeers !== undefined) {
    next.TMEX_HUB_PEERS =
      typeof patch.hubPeers === 'string' ? patch.hubPeers : patch.hubPeers.join(',');
  }
  return next;
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

export function generateRelayAdminToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 只有 relay / relay,node 才写中继键，避免给其它角色的 app.env 塞无用项。 */
export function relayEnvDefaults(input?: {
  role?: TmexRoleName;
  relayPublicUrl?: string;
  relayAdminToken?: string;
}): Record<string, string> {
  if (input?.role !== 'relay' && input?.role !== 'relay,node') return {};
  return {
    TMEX_RELAY_PUBLIC_URL: input.relayPublicUrl ?? '',
    TMEX_RELAY_ADMIN_TOKEN: input.relayAdminToken || generateRelayAdminToken(),
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
    ...relayEnvDefaults(input),
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

export function buildRunScriptContent(installDir: string, bunPath: string): string {
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
  const current = currentRuntimePaths(installDir);
  const envPath = join(installDir, 'app.env');
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
    `done < ${quotePosixShellArg(envPath)}`,
    '',
    'if [[ -n "${HOME:-}" ]] && [[ -d "${HOME}/.bun/bin" ]]; then',
    '  export PATH="${HOME}/.bun/bin:${PATH:-}"',
    'fi',
    pathExport,
    '',
    `export TMEX_INSTALL_DIR=${quotePosixShellArg(installDir)}`,
    `export TMEX_FE_DIST_DIR=${quotePosixShellArg(current.feDir)}`,
    `export TMEX_MIGRATIONS_DIR=${quotePosixShellArg(current.drizzleDir)}`,
    `export TMEX_NATIVE_DIR=${quotePosixShellArg(current.nativeDir)}`,
    '',
    'printf \'%s\\n\' "$$" > "$SCRIPT_DIR/tmex.pid"',
    `exec ${quotePosixShellArg(bunPath)} ${quotePosixShellArg(current.runtimeServerPath)}`,
    '',
  ];
  return lines.join('\n');
}

export async function writeRunScript(installLayout: InstallLayout, bunPath: string): Promise<void> {
  const script = buildRunScriptContent(installLayout.installDir, bunPath);
  const existing = await readText(installLayout.runScriptPath).catch(() => null);
  if (existing === script) {
    await chmod(installLayout.runScriptPath, 0o755).catch(() => null);
    return;
  }
  await writeTextAtomic(installLayout.runScriptPath, script, 0o755);
  await chmod(installLayout.runScriptPath, 0o755);
}

export async function writeInstallMeta(
  installLayout: InstallLayout,
  meta: InstallMeta
): Promise<void> {
  await writeJsonFile(installLayout.metaPath, meta, 0o600);
}
