import { lstat, readFile, readlink, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

export function stringifyEnv(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${values[key]}`);

  return `${lines.join('\n')}\n`;
}

const ENV_PREFIX = 'VIBETERM_';
const LEGACY_ENV_PREFIX = 'TMEX_';

/**
 * 未迁移的安装里 app.env 还是 `TMEX_*`：读出来时补一份 `VIBETERM_*` 别名（已有新键优先），
 * 让直接读文件的命令（如 `relay status`）在迁移之前也能找到键。
 */
export function applyLegacyEnvAliases(values: Record<string, string>): Record<string, string> {
  const next = { ...values };
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX)) continue;
    const aliased = `${ENV_PREFIX}${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (aliased in next) continue;
    next[aliased] = value;
  }
  return next;
}

/** 写回时去掉读取时补出来的别名，保持文件原样，避免同一项在文件里出现两行。 */
export function stripLegacyEnvAliases(values: Record<string, string>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith(ENV_PREFIX)) {
      const legacy = `${LEGACY_ENV_PREFIX}${key.slice(ENV_PREFIX.length)}`;
      if (values[legacy] === value) continue;
    }
    next[key] = value;
  }
  return next;
}

export async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  const content = await readFile(filePath, 'utf8');
  return applyLegacyEnvAliases(parseEnvContent(content));
}

const MAX_SYMLINK_HOPS = 32;

function symlinkResolveError(filePath: string): Error {
  return new Error(`cannot resolve env file symlink: ${filePath}`);
}

export async function resolveEnvWriteTarget(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw symlinkResolveError(filePath);
    }
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  let current = resolve(filePath);
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current) || seen.size >= MAX_SYMLINK_HOPS) {
      throw symlinkResolveError(filePath);
    }
    seen.add(current);

    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return seen.size === 1 ? filePath : current;
      }
      throw error;
    }

    if (!stat.isSymbolicLink()) {
      return current;
    }

    let target: string;
    try {
      target = await readlink(current);
    } catch {
      throw symlinkResolveError(filePath);
    }
    current = resolve(dirname(current), target);
  }
}

export async function writeEnvFile(
  filePath: string,
  values: Record<string, string>
): Promise<void> {
  const targetPath = await resolveEnvWriteTarget(filePath);
  const tempPath = join(
    dirname(targetPath),
    `${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(tempPath, stringifyEnv(stripLegacyEnvAliases(values)), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(tempPath, targetPath);
}

/**
 * 补默认值时把 `TMEX_X` 视为 `VIBETERM_X` 已存在，避免同一项在文件里出现两份。
 */
function hasKeyOrLegacyAlias(values: Record<string, string>, key: string): boolean {
  if (key in values) return true;
  if (!key.startsWith(ENV_PREFIX)) return false;
  return `${LEGACY_ENV_PREFIX}${key.slice(ENV_PREFIX.length)}` in values;
}

export function mergeMissingKeys(
  existing: Record<string, string>,
  defaults: Record<string, string>
): { next: Record<string, string>; added: string[] } {
  const next = { ...existing };
  const added: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (!hasKeyOrLegacyAlias(next, key)) {
      next[key] = value;
      added.push(key);
    }
  }
  return { next, added };
}

export async function mergeMissingEnvFileKeys(
  filePath: string,
  defaults: Record<string, string>
): Promise<string[]> {
  const existing = await readEnvFile(filePath);
  const { next, added } = mergeMissingKeys(existing, defaults);
  if (added.length > 0) {
    await writeEnvFile(filePath, next);
  }
  return added;
}
