import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MIN_BUN_VERSION = '1.3.0';
export const DEFAULT_SERVICE_NAME = 'vibeterm';

/** 改名后的默认安装目录（新装用） */
export function newInstallDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'vibeterm');
  }
  return resolve(homedir(), '.local', 'share', 'vibeterm');
}

/** 改名前的安装目录；已有安装原地升级后仍留在这里。 */
export function legacyInstallDir(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return resolve(homedir(), 'Library', 'Application Support', 'tmex');
  }
  return resolve(homedir(), '.local', 'share', 'tmex');
}

function hasInstall(dir: string): boolean {
  return existsSync(join(dir, 'install-meta.json'));
}

/**
 * 新目录已有安装就用新目录；否则旧目录里有安装时返回旧目录——升级还没跑之前，
 * 已有安装的一切（app.env / data / plist）都还在旧路径上，必须先能找到它。
 */
export function pickInstallDir(
  current: string,
  legacy: string,
  exists: (dir: string) => boolean = hasInstall
): string {
  if (exists(current)) return current;
  return exists(legacy) ? legacy : current;
}

export function defaultInstallDir(platform: NodeJS.Platform): string {
  return pickInstallDir(newInstallDir(platform), legacyInstallDir(platform));
}

export function defaultDatabasePath(installDir: string): string {
  return resolve(installDir, 'data', 'vibeterm.db');
}

export function defaultHost(): string {
  return '127.0.0.1';
}

export function defaultPort(): number {
  return 9883;
}
