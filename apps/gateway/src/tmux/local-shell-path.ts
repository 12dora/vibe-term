import { existsSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';

const SHELL_ENV_BEGIN_MARKER = '__TMEX_SHELL_ENV_BEGIN__';
const SHELL_ENV_END_MARKER = '__TMEX_SHELL_ENV_END__';
const SHELL_ENV_PROBE_COMMAND = `printf '${SHELL_ENV_BEGIN_MARKER}\\n'; /usr/bin/env; printf '${SHELL_ENV_END_MARKER}\\n'`;

interface RunSyncResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LocalShellPathCacheDeps {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
  platform: NodeJS.Platform;
  runSync: (cmd: string[]) => RunSyncResult;
}

export interface LocalShellPathCache {
  get(): string | null;
  prime(): string | null;
}

function findEnvEntry(
  env: NodeJS.ProcessEnv,
  key: string,
  caseInsensitive: boolean
): [string, string | undefined] | null {
  if (!caseInsensitive) {
    return Object.hasOwn(env, key) ? [key, env[key]] : null;
  }
  const normalized = key.toUpperCase();
  for (const [candidate, value] of Object.entries(env)) {
    if (candidate.toUpperCase() === normalized) {
      return [candidate, value];
    }
  }
  return null;
}

function getEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  caseInsensitive: boolean
): string | undefined {
  return findEnvEntry(env, key, caseInsensitive)?.[1];
}

function setEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  caseInsensitive: boolean
): void {
  const existingKey = findEnvEntry(env, key, caseInsensitive)?.[0];
  env[existingKey ?? key] = value;
}

export function getLocalParkingCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') {
    return 'sleep 30';
  }
  // psmux 的 default-shell 可由用户配置；使用 pwsh、Windows PowerShell、cmd 与
  // Git Bash 都能直接执行的命令，避免 Gateway 对 shell 做出不同判断。
  return 'ping.exe -n 31 127.0.0.1';
}

function defaultRunSync(cmd: string[]): RunSyncResult {
  const result = Bun.spawnSync(cmd, {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString('utf8'),
    stderr: Buffer.from(result.stderr).toString('utf8'),
  };
}

function resolveShellFromDscl(deps: LocalShellPathCacheDeps): string | null {
  if (deps.platform !== 'darwin') {
    return null;
  }

  const username = deps.env.USER?.trim() || deps.env.LOGNAME?.trim();
  if (!username) {
    return null;
  }

  const result = deps.runSync(['/usr/bin/dscl', '.', '-read', `/Users/${username}`, 'UserShell']);
  if (result.exitCode !== 0) {
    return null;
  }

  const matched = result.stdout.match(/UserShell:\s*(\S+)/);
  const shellPath = matched?.[1]?.trim();
  if (!shellPath || !deps.fileExists(shellPath)) {
    return null;
  }

  return shellPath;
}

function resolveDefaultShell(deps: LocalShellPathCacheDeps): string | null {
  const envShell = deps.env.SHELL?.trim();
  if (envShell && deps.fileExists(envShell)) {
    return envShell;
  }

  const dsclShell = resolveShellFromDscl(deps);
  if (dsclShell) {
    return dsclShell;
  }

  const fallbackShell = deps.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  if (deps.fileExists(fallbackShell)) {
    return fallbackShell;
  }

  return null;
}

function extractPathFromShellEnv(stdout: string): string | null {
  const beginIndex = stdout.lastIndexOf(SHELL_ENV_BEGIN_MARKER);
  if (beginIndex < 0) {
    return null;
  }

  const endIndex = stdout.indexOf(SHELL_ENV_END_MARKER, beginIndex + SHELL_ENV_BEGIN_MARKER.length);
  if (endIndex < 0) {
    return null;
  }

  const body = stdout.slice(beginIndex + SHELL_ENV_BEGIN_MARKER.length, endIndex);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('PATH=')) {
      continue;
    }

    const value = line.slice('PATH='.length).trim();
    return value.length > 0 ? value : null;
  }

  return null;
}

function canResolveExecutableFromPath(
  resolvedPath: string,
  executableName: string,
  deps: LocalShellPathCacheDeps
): boolean {
  const pathDelimiter = deps.platform === 'win32' ? win32.delimiter : delimiter;
  const joinPath = deps.platform === 'win32' ? win32.join : join;
  for (const rawDir of resolvedPath.split(pathDelimiter)) {
    const dir = rawDir.trim();
    if (!dir) {
      continue;
    }

    if (deps.fileExists(joinPath(dir, executableName))) {
      return true;
    }
  }

  return false;
}

function probeShellPath(shellPath: string, deps: LocalShellPathCacheDeps): string | null {
  const attempts = [
    [shellPath, '-l', '-c', SHELL_ENV_PROBE_COMMAND],
    [shellPath, '-l', '-i', '-c', SHELL_ENV_PROBE_COMMAND],
    [shellPath, '-c', SHELL_ENV_PROBE_COMMAND],
  ];
  let fallbackPath: string | null = null;

  for (const cmd of attempts) {
    const result = deps.runSync(cmd);
    if (result.exitCode !== 0) {
      continue;
    }

    const resolvedPath = extractPathFromShellEnv(result.stdout);
    if (!resolvedPath) {
      continue;
    }

    fallbackPath ??= resolvedPath;
    if (canResolveExecutableFromPath(resolvedPath, 'tmux', deps)) {
      return resolvedPath;
    }
  }

  return fallbackPath;
}

export function createLocalShellPathCache(
  input: Partial<LocalShellPathCacheDeps> = {}
): LocalShellPathCache {
  const deps: LocalShellPathCacheDeps = {
    env: input.env ?? process.env,
    fileExists: input.fileExists ?? existsSync,
    platform: input.platform ?? process.platform,
    runSync: input.runSync ?? defaultRunSync,
  };

  let initialized = false;
  let cachedPath: string | null = null;

  return {
    get() {
      return initialized ? cachedPath : null;
    },
    prime() {
      if (initialized) {
        return cachedPath;
      }

      initialized = true;
      if (deps.platform === 'win32') {
        const inheritedPath = getEnvValue(deps.env, 'PATH', true)?.trim();
        cachedPath = inheritedPath || null;
        return cachedPath;
      }
      const shellPath = resolveDefaultShell(deps);
      if (!shellPath) {
        return null;
      }

      cachedPath = probeShellPath(shellPath, deps);
      return cachedPath;
    },
  };
}

const defaultLocalShellPathCache = createLocalShellPathCache();

export function primeLocalShellPath(): string | null {
  return defaultLocalShellPathCache.prime();
}

export function getLocalShellPath(): string | null {
  return defaultLocalShellPathCache.get();
}

// tmex 自身注入的环境变量（生产由 run.sh 经 app.env 注入 gateway 进程）。
// 这些绝不能漏进 tmex 拉起的 tmux 服务端——否则用户终端会继承：
// - 污染正常环境（NODE_ENV=production / DATABASE_URL / 各 TMEX_* 配置）；
// - 泄露密钥（TMEX_MASTER_KEY 是加密所有凭证的主密钥）。
// 绝大多数为 TMEX_ 前缀，少数非前缀键单列。
const TMEX_INJECTED_ENV_EXACT = new Set(['NODE_ENV', 'DATABASE_URL', 'GATEWAY_PORT', 'FE_PORT']);

function isTmexInjectedEnvKey(key: string, caseInsensitive: boolean): boolean {
  const normalized = caseInsensitive ? key.toUpperCase() : key;
  return normalized.startsWith('TMEX_') || TMEX_INJECTED_ENV_EXACT.has(normalized);
}

function isUtf8Locale(value: string | undefined): boolean {
  return typeof value === 'string' && /utf-?8/i.test(value);
}

export function buildLocalTmuxEnv(
  resolvedPath: string | null,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const caseInsensitive = platform === 'win32';
  const nextEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (isTmexInjectedEnvKey(key, caseInsensitive)) {
      continue;
    }
    nextEnv[key] = value;
  }

  if (resolvedPath) {
    setEnvValue(nextEnv, 'PATH', resolvedPath, caseInsensitive);
  }

  const lcAll = getEnvValue(nextEnv, 'LC_ALL', caseInsensitive);
  const lcCtype = getEnvValue(nextEnv, 'LC_CTYPE', caseInsensitive);
  const lang = getEnvValue(nextEnv, 'LANG', caseInsensitive);
  if (!isUtf8Locale(lcAll) && (lcAll || (!isUtf8Locale(lcCtype) && !isUtf8Locale(lang)))) {
    setEnvValue(nextEnv, 'LC_ALL', 'C.UTF-8', caseInsensitive);
  }

  return nextEnv;
}
