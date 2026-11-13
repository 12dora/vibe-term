import { lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { isTokenFileAccess } from '../auth/token-scope';
import { config } from '../config';

const TOKEN_DENY_HOME_FILES = [
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  '.zprofile',
] as const;

export const tokenDenyEnv = {
  homedir(): string {
    return homedir();
  },
  databaseUrl(): string {
    return config.databaseUrl;
  },
  installDir(): string | undefined {
    return process.env.VIBETERM_INSTALL_DIR;
  },
  xdgConfigHome(): string | undefined {
    return process.env.XDG_CONFIG_HOME;
  },
  cliHome(): string | undefined {
    return process.env.VIBETERM_CLI_HOME;
  },
  platform(): NodeJS.Platform {
    return process.platform;
  },
};

export function installDataDirsFromDatabaseUrl(databaseUrl: string): string[] {
  const trimmed = databaseUrl.trim();
  if (!trimmed || trimmed === ':memory:' || trimmed.startsWith('file::memory:')) return [];
  const dbPath = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
  const dataDir = dirname(dbPath);
  const dirs = [dataDir];
  if (basename(dataDir) === 'data') dirs.push(dirname(dataDir));
  return dirs;
}

const MAX_LINK_HOPS = 40;

type Resolution = { path: string | null; visited: string[] };

/**
 * 逐级解析符号链接（悬空链接也按其目标继续），不存在的分量按字面保留并继续处理后续分量。
 * `visited` 记下途经的每个目录项位置（含链接本身与不存在的分量）：它们都是这条路径解析的依赖。
 * 解析不了（链接环、读不到链接）时 `path` 为 null，调用方按拒绝处理。
 */
function resolveWithDeps(path: string): Resolution {
  const pending = (isAbsolute(path) ? path : resolve(path)).split('/').filter(Boolean);
  const visited: string[] = [];
  let current = '/';
  let hops = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    visited.push(next);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { path: null, visited };
      current = next;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) return { path: null, visited };
    let target: string;
    try {
      target = readlinkSync(next);
    } catch {
      return { path: null, visited };
    }
    pending.unshift(...target.split('/').filter(Boolean));
    if (isAbsolute(target)) current = '/';
  }
  return { path: current, visited };
}

function realOrLexical(path: string): string | null {
  return resolveWithDeps(path).path;
}

/** 目录项自身所在位置：父目录取真实路径，末段不展开（移动 / 改名作用于目录项本身）。 */
function entryLocation(path: string): string | null {
  const parent = realOrLexical(dirname(path));
  return parent === null ? null : join(parent, basename(path));
}

function foldPath(path: string): string {
  return tokenDenyEnv.platform() === 'darwin' ? path.normalize('NFC').toLowerCase() : path;
}

function pathIsInside(target: string, root: string): boolean {
  const foldedTarget = foldPath(target);
  const foldedRoot = foldPath(root);
  if (foldedTarget === foldedRoot) return true;
  const prefix = foldedRoot.endsWith('/') ? foldedRoot : `${foldedRoot}/`;
  return foldedTarget.startsWith(prefix);
}

function resolvedEnvDir(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function tokenDenyDirs(): string[] {
  const home = tokenDenyEnv.homedir();
  const dirs = [
    ...installDataDirsFromDatabaseUrl(tokenDenyEnv.databaseUrl()),
    join(home, '.config', 'vibeterm'),
    join(home, '.ssh'),
    join(home, '.config', 'systemd', 'user'),
    join(home, 'Library', 'LaunchAgents'),
    join(home, '.local', 'share', 'tmex'),
    join(home, 'Library', 'Application Support', 'vibeterm'),
    join(home, 'Library', 'Application Support', 'tmex'),
  ];
  const install = resolvedEnvDir(tokenDenyEnv.installDir());
  if (install) dirs.push(install);
  const xdg = resolvedEnvDir(tokenDenyEnv.xdgConfigHome());
  if (xdg) dirs.push(join(xdg, 'vibeterm'));
  const cli = resolvedEnvDir(tokenDenyEnv.cliHome());
  if (cli) dirs.push(cli);
  return dirs;
}

function tokenDenyFiles(): string[] {
  const home = tokenDenyEnv.homedir();
  return TOKEN_DENY_HOME_FILES.map((name) => join(home, name));
}

function denyEntryPath(entry: string): string {
  return realOrLexical(entry) ?? resolve(entry);
}

function pathDeniedForToken(absPath: string, coversAncestors: boolean): boolean {
  if (tokenLocalPathDenied(absPath)) return true;
  if (!coversAncestors) return false;
  const target = realOrLexical(absPath);
  const location = entryLocation(absPath);
  if (target === null || location === null) return true;
  return [...tokenDenyDirs(), ...tokenDenyFiles()].some((entry) => {
    if (pathIsInside(denyEntryPath(entry), target)) return true;
    return resolveWithDeps(entry).visited.some((dep) => pathIsInside(dep, location));
  });
}

/** 令牌对本机路径的不可覆盖拒绝集（逐级解析符号链接）。会话调用方不走这里。 */
export function tokenLocalPathDenied(absPath: string): boolean {
  const target = realOrLexical(absPath);
  if (target === null) return true;
  for (const dir of tokenDenyDirs()) {
    if (pathIsInside(target, denyEntryPath(dir))) return true;
  }
  for (const file of tokenDenyFiles()) {
    if (foldPath(target) === foldPath(denyEntryPath(file))) return true;
  }
  return false;
}

/**
 * 令牌对本机路径的改动闸门：source 含祖先；destination 是最终落点（含祖先，
 * 因此把名为 `.ssh` / `user` 的目录移到位会命中拒绝集）。
 */
export function tokenMutationDenied(
  device: Device,
  sourcePath: string | null,
  destPath: string | null
): boolean {
  if (device.type !== 'local' || !isTokenFileAccess()) return false;
  if (sourcePath && pathDeniedForToken(sourcePath, true)) return true;
  return Boolean(destPath && pathDeniedForToken(destPath, true));
}
