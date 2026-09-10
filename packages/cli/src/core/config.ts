// 配置目录与默认 entry 的解析。所有对安装目录的访问都是只读的：CLI 从不改写本机安装。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { UsageError } from './errors';

export const DEFAULT_ENTRY = 'http://127.0.0.1:9883';
export const SESSION_FILE_NAME = 'session.json';

export type ConfigEnv = Record<string, string | undefined>;

/** `$VIBETERM_CLI_HOME` > `$XDG_CONFIG_HOME/vibeterm` > `~/.config/vibeterm`。 */
export function configDir(env: ConfigEnv = process.env, home: string = homedir()): string {
  const explicit = env.VIBETERM_CLI_HOME?.trim();
  if (explicit) return resolve(explicit);
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) return resolve(xdg, 'vibeterm');
  return resolve(home, '.config', 'vibeterm');
}

export function sessionFilePath(dir: string): string {
  return join(dir, SESSION_FILE_NAME);
}

/** 安装目录：与 packages/app 的 `defaultInstallDir` 同规则（新名优先，回落改名前的目录）。 */
export function defaultInstallDir(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const roots =
    platform === 'darwin'
      ? [
          resolve(home, 'Library', 'Application Support', 'vibeterm'),
          resolve(home, 'Library', 'Application Support', 'tmex'),
        ]
      : [resolve(home, '.local', 'share', 'vibeterm'), resolve(home, '.local', 'share', 'tmex')];
  const installed = roots.find((dir) => existsSync(join(dir, 'install-meta.json')));
  return installed ?? roots[0];
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

/** 只读本机安装的 `app.env`，取 `VIBETERM_BASE_URL`（未迁移的安装里是 `TMEX_BASE_URL`）。 */
export function installBaseUrl(installDir: string = defaultInstallDir()): string | undefined {
  const path = join(installDir, 'app.env');
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const values = parseEnvFile(content);
  const url = values.VIBETERM_BASE_URL ?? values.TMEX_BASE_URL;
  const trimmed = url?.trim();
  return trimmed ? trimmed : undefined;
}

/** 归一化 entry：补 scheme、去掉尾斜杠与路径外的多余部分，非法值直接报用法错误。 */
export function normalizeEntry(input: string): string {
  const raw = input.trim();
  if (!raw) throw new UsageError('entry url is empty');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UsageError(`invalid entry url: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`entry url must be http(s): ${input}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export function entryOrigin(entry: string): string {
  return new URL(entry).origin;
}

export interface EntrySources {
  flag?: string;
  env?: string;
  session?: string;
  install?: string;
}

/** `--entry` > `$VIBETERM_ENTRY` > 会话文件里最后用过的 entry > 安装版 `VIBETERM_BASE_URL` > 本机默认。 */
export function pickEntry(sources: EntrySources): string {
  const chosen = sources.flag ?? sources.env ?? sources.session ?? sources.install ?? DEFAULT_ENTRY;
  return normalizeEntry(chosen);
}
