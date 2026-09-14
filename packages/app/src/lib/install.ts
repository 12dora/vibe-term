import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  type PortRole,
  defaultRtcPortRange,
  rolesIncludeRelay,
} from '../../../shared/src/net/port-plan';
import { formatHttpEndpoint } from '../../../shared/src/network';
import { normalizeLegacyRoleName } from '../../../shared/src/roles';
import type { InstallMeta } from '../types';
import { copyDirectory, ensureDir, pathExists, readText, writeTextAtomic } from './fs-utils';
import { type InstallLayout, type PackageLayout, currentRuntimePaths } from './install-layout';
import { writeJsonFile } from './json-file';
import { DEFAULT_PEER_PORT, type VibeTermRoleName } from './roles';

export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

export interface AppEnvInput {
  host: string;
  port: number;
  databasePath: string;
  masterKey: string;
  role?: VibeTermRoleName;
  peerPort?: number;
  relayPublicUrl?: string;
  relayAdminToken?: string;
  stunServers?: string;
}

export function peerEnvDefaults(input?: {
  role?: VibeTermRoleName;
  peerPort?: number;
  stunServers?: string;
}): Record<string, string> {
  const role = input?.role ?? 'standalone';
  const stun = input?.stunServers?.trim();
  return {
    VIBETERM_ROLES: role,
    VIBETERM_PEER_PORT: String(input?.peerPort ?? DEFAULT_PEER_PORT),
    ...(stun ? { VIBETERM_STUN_SERVERS: stun } : {}),
  };
}

/** 升级时把残留 `hub,node` 写成 `node`，并丢掉全部 `VIBETERM_HUB_*` / `TMEX_HUB_*`。 */
export function rewriteLegacyHubInstallEnv(env: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('VIBETERM_HUB_') || key.startsWith('TMEX_HUB_')) continue;
    if (key === 'VIBETERM_ROLES' || key === 'TMEX_ROLES') {
      const { name, legacy } = normalizeLegacyRoleName(value);
      next[key] = legacy ? name : value;
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function generateRelayAdminToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 只有 relay / relay,node 才写中继键，避免给其它角色的 app.env 塞无用项。 */
export function relayEnvDefaults(input?: {
  role?: VibeTermRoleName;
  relayPublicUrl?: string;
  relayAdminToken?: string;
}): Record<string, string> {
  if (input?.role !== 'relay' && input?.role !== 'relay,node') return {};
  return {
    VIBETERM_RELAY_PUBLIC_URL: input.relayPublicUrl ?? '',
    VIBETERM_RELAY_ADMIN_TOKEN: input.relayAdminToken || generateRelayAdminToken(),
  };
}

function portEnvDefaults(role?: VibeTermRoleName): Record<string, string> {
  const resolved: PortRole = role ?? 'standalone';
  const rtc = defaultRtcPortRange(resolved);
  const values: Record<string, string> = {
    VIBETERM_RTC_PORT_RANGE: `${rtc.begin}-${rtc.end}`,
  };
  if (rolesIncludeRelay(resolved)) {
    values.VIBETERM_TURN_PORT = String(DEFAULT_TURN_PORT);
    values.VIBETERM_TURN_RELAY_PORT_RANGE = `${DEFAULT_TURN_RELAY_PORT_RANGE.begin}-${DEFAULT_TURN_RELAY_PORT_RANGE.end}`;
  }
  return values;
}

export function buildAppEnvValues(input: AppEnvInput): Record<string, string> {
  return {
    NODE_ENV: 'production',
    VIBETERM_BIND_HOST: input.host,
    GATEWAY_PORT: String(input.port),
    DATABASE_URL: input.databasePath,
    VIBETERM_MASTER_KEY: input.masterKey,
    VIBETERM_BASE_URL: formatHttpEndpoint(input.host, input.port),
    VIBETERM_SITE_NAME: 'VibeTerm',
    VIBETERM_DIRECT_ENABLED: 'true',
    ...peerEnvDefaults(input),
    ...relayEnvDefaults(input),
    ...portEnvDefaults(input.role),
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

function ghosttyWasmPathExport(runtimeDir: string): string[] {
  const wasmPath = join(runtimeDir, 'assets', 'ghostty-vt.wasm');
  if (!existsSync(wasmPath)) return [];
  return [`export VIBETERM_GHOSTTY_WASM_PATH=${quotePosixShellArg(wasmPath)}`];
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
    `export VIBETERM_INSTALL_DIR=${quotePosixShellArg(installDir)}`,
    `export VIBETERM_FE_DIST_DIR=${quotePosixShellArg(current.feDir)}`,
    `export VIBETERM_MIGRATIONS_DIR=${quotePosixShellArg(current.drizzleDir)}`,
    `export VIBETERM_NATIVE_DIR=${quotePosixShellArg(current.nativeDir)}`,
    ...ghosttyWasmPathExport(current.runtimeDir),
    '',
    'printf \'%s\\n\' "$$" > "$SCRIPT_DIR/vibeterm.pid"',
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
